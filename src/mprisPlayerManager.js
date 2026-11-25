import Gio from "gi://Gio";
import GLib from "gi://GLib";
import Shell from "gi://Shell";
import { matchesFocusedApplication } from "./focusedPlayerMatcher.js";
import { MPRIS_INTERFACE, DBUS_INTERFACE } from "./dbusInterfaces.js";

export class MprisPlayerManager {
    constructor(settings, delegate) {
        this._settings = settings;
        this._delegate = delegate;
        this._isDestroyed = false;
        this._players = new Map();
        this._nameOwnerChangedSignalId = null;
        this._focusedPlayerAddress = null;
        this._focusSyncIdleId = null;

        this._windowTracker = Shell.WindowTracker.get_default();
        this._focusAppChangedSignalId = this._windowTracker.connect(
            "notify::focus-app",
            () => this._scheduleFocusSync(),
        );

        this._initDBus();
    }

    _initDBus() {
        const dBusProxyWrapper = Gio.DBusProxy.makeProxyWrapper(DBUS_INTERFACE);

        this.dBusProxy = dBusProxyWrapper(
            Gio.DBus.session,
            "org.freedesktop.DBus",
            "/org/freedesktop/DBus",
            () => {
                const [names] = this.dBusProxy.ListNamesSync();
                for (const name of names) {
                    if (name.startsWith("org.mpris.MediaPlayer2"))
                        this._addPlayer(name);
                }
            },
        );

        this._nameOwnerChangedSignalId = this.dBusProxy.connectSignal(
            "NameOwnerChanged",
            (_proxy, _sender, [name, _oldOwner, newOwner]) => {
                if (!name.startsWith("org.mpris.MediaPlayer2")) return;

                if (newOwner && !this._players.has(name)) this._addPlayer(name);
                else if (!newOwner && this._players.has(name))
                    this._removePlayer(name);
            },
        );
    }

    _addPlayer(address) {
        if (this._isDestroyed || this._players.has(address)) return;

        const proxyWrapper = Gio.DBusProxy.makeProxyWrapper(MPRIS_INTERFACE);
        const entry = {
            proxy: null,
            propId: null,
            identity: "",
            lastActive: GLib.get_monotonic_time(),
        };
        this._players.set(address, entry);

        entry.proxy = proxyWrapper(
            Gio.DBus.session,
            address,
            "/org/mpris/MediaPlayer2",
            async () => {
                if (this._isDestroyed || !this._players.has(address)) return;

                await this._registerPlayerInFilters(address);

                if (this._isDestroyed || !this._players.has(address)) return;

                entry.lastActive = GLib.get_monotonic_time();
                this._syncActivePlayer(address);
            },
        );

        entry.propId = entry.proxy.connect("g-properties-changed", () => {
            if (this._isDestroyed || !this._players.has(address)) return;

            entry.lastActive = GLib.get_monotonic_time();
            this._syncActivePlayer(address);
        });
    }

    _removePlayer(address) {
        const entry = this._players.get(address);
        if (!entry) return;

        if (entry.propId && entry.proxy) entry.proxy.disconnect(entry.propId);
        this._players.delete(address);

        this._syncActivePlayer();
    }

    _scheduleFocusSync() {
        if (this._isDestroyed || this._focusSyncIdleId) return;

        // Coalesce transient focus-app changes emitted during one focus switch.
        this._focusSyncIdleId = GLib.idle_add(
            GLib.PRIORITY_DEFAULT_IDLE,
            () => {
                this._focusSyncIdleId = null;
                if (!this._isDestroyed) this._syncFocusedPlayer();
                return GLib.SOURCE_REMOVE;
            },
        );
    }

    _findFocusedPlayerAddress() {
        const focusedAppId = this._windowTracker?.focus_app?.id;
        if (!focusedAppId) return null;

        let playingCandidate = null;
        let playingTime = -1;
        let pausedCandidate = null;
        let pausedTime = -1;

        for (const [address, entry] of this._players) {
            if (
                !entry.proxy ||
                !matchesFocusedApplication(
                    focusedAppId,
                    address,
                    entry.identity,
                )
            )
                continue;

            const playbackStatus = entry.proxy.PlaybackStatus;

            if (
                playbackStatus === "Playing" &&
                entry.lastActive > playingTime
            ) {
                playingTime = entry.lastActive;
                playingCandidate = address;
            } else if (
                playbackStatus === "Paused" &&
                entry.lastActive > pausedTime
            ) {
                pausedTime = entry.lastActive;
                pausedCandidate = address;
            }
        }

        // A stopped browser/player must not claim focus over active playback.
        return playingCandidate || pausedCandidate;
    }

    _pickNextActivePlayer() {
        let playingCandidate = null;
        let playingTime = -1;
        let pausedCandidate = null;
        let pausedTime = -1;

        for (const [address, entry] of this._players) {
            if (!entry.proxy) continue;

            const playbackStatus = entry.proxy.PlaybackStatus;

            if (
                playbackStatus === "Playing" &&
                entry.lastActive > playingTime
            ) {
                playingTime = entry.lastActive;
                playingCandidate = address;
            } else if (
                playbackStatus === "Paused" &&
                entry.lastActive > pausedTime
            ) {
                pausedTime = entry.lastActive;
                pausedCandidate = address;
            }
        }

        // Prefer any playing session over every paused session.
        // Stopped sessions are intentionally excluded.
        return playingCandidate || pausedCandidate;
    }

    _selectPreferredPlayerAddress() {
        this._focusedPlayerAddress = this._findFocusedPlayerAddress();

        if (this._focusedPlayerAddress) {
            const focusedEntry = this._players.get(
                this._focusedPlayerAddress,
            );

            if (focusedEntry?.proxy?.PlaybackStatus === "Playing")
                return this._focusedPlayerAddress;
        }

        const nextAddress = this._pickNextActivePlayer();
        if (!nextAddress) return null;

        const nextEntry = this._players.get(nextAddress);
        if (nextEntry?.proxy?.PlaybackStatus === "Playing")
            return nextAddress;

        // When nothing is playing, retain the focused app's paused session.
        return this._focusedPlayerAddress || nextAddress;
    }

    _syncActivePlayer(changedAddress = null) {
        if (this._isDestroyed) return;

        const nextAddress = this._selectPreferredPlayerAddress();
        const activeAddress = this._delegate.getActiveAddress();

        if (nextAddress) {
            // Refresh metadata when the currently active player emitted a change.
            if (nextAddress !== activeAddress || nextAddress === changedAddress)
                this._activate(nextAddress);
            return;
        }

        if (activeAddress) this._delegate.clearActivePlayer();
        else this._delegate.refreshVisibility();
    }

    _syncFocusedPlayer() {
        this._syncActivePlayer();
    }

    _activate(address) {
        const entry = this._players.get(address);
        if (!entry || !entry.proxy) return;
        this._delegate.activatePlayer(address, entry.proxy);
    }

    getAppIdentifier(address) {
        if (!address) return null;
        const id = address.replace(/^org\.mpris\.MediaPlayer2\./, "");
        return id.split(".instance")[0];
    }

    async _registerPlayerInFilters(address) {
        const appId = this.getAppIdentifier(address);
        if (!appId) return;

        try {
            let identity = "Unknown Player";
            const connection = Gio.DBus.session;

            const result = await connection.call(
                address,
                "/org/mpris/MediaPlayer2",
                "org.freedesktop.DBus.Properties",
                "Get",
                new GLib.Variant("(ss)", [
                    "org.mpris.MediaPlayer2",
                    "Identity",
                ]),
                null,
                Gio.DBusCallFlags.NONE,
                -1,
                null,
            );

            if (result) {
                const [variant] = result.recursiveUnpack();
                identity = variant;
            }

            const entry = this._players.get(address);
            if (entry) entry.identity = String(identity ?? "");

            const players = JSON.parse(
                this._settings.get_string("media-players"),
            );

            if (!players[appId]) {
                players[appId] = { name: identity, visible: true };
                this._settings.set_string(
                    "media-players",
                    JSON.stringify(players),
                );
            }
        } catch (e) {
            log(`Error registering player: ${e.message}`);
        }
    }

    call(address, method) {
        if (!address) return;

        Gio.DBus.session.call(
            address,
            "/org/mpris/MediaPlayer2",
            "org.mpris.MediaPlayer2.Player",
            method,
            null,
            null,
            Gio.DBusCallFlags.NONE,
            -1,
            null,
            null,
        );
    }

    seek(address, offsetUs) {
        if (!address) return;

        Gio.DBus.session.call(
            address,
            "/org/mpris/MediaPlayer2",
            "org.mpris.MediaPlayer2.Player",
            "Seek",
            new GLib.Variant("(x)", [offsetUs]),
            null,
            Gio.DBusCallFlags.NONE,
            -1,
            null,
            null,
        );
    }

    async getPosition(address) {
        if (!address) return null;

        try {
            const result = await Gio.DBus.session.call(
                address,
                "/org/mpris/MediaPlayer2",
                "org.freedesktop.DBus.Properties",
                "Get",
                new GLib.Variant("(ss)", [
                    "org.mpris.MediaPlayer2.Player",
                    "Position",
                ]),
                null,
                Gio.DBusCallFlags.NONE,
                -1,
                null,
            );

            if (!result) return null;
            const [variant] = result.recursiveUnpack();
            return Number(variant) || 0;
        } catch (_e) {
            return null;
        }
    }

    destroy() {
        if (this._isDestroyed) return;
        this._isDestroyed = true;

        if (this._focusSyncIdleId) {
            GLib.source_remove(this._focusSyncIdleId);
            this._focusSyncIdleId = null;
        }

        if (this._windowTracker && this._focusAppChangedSignalId) {
            this._windowTracker.disconnect(this._focusAppChangedSignalId);
            this._focusAppChangedSignalId = null;
        }
        this._windowTracker = null;
        this._focusedPlayerAddress = null;

        if (this.dBusProxy && this._nameOwnerChangedSignalId) {
            this.dBusProxy.disconnectSignal(this._nameOwnerChangedSignalId);
            this._nameOwnerChangedSignalId = null;
        }

        for (const [, entry] of this._players) {
            if (entry.propId && entry.proxy)
                entry.proxy.disconnect(entry.propId);
        }
        this._players.clear();
        this.dBusProxy = null;
    }
}
