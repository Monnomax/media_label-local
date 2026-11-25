/**
 * Enforces one active MPRIS playback session.
 * Commands are provided by MprisPlayerManager so this policy stays testable
 * without GNOME Shell or D-Bus.
 */
export class ExclusivePlaybackController {
    constructor(settings, players, sendCommand) {
        this._settings = settings;
        this._players = players;
        this._sendCommand = sendCommand;
        this._pausedByUs = new Map();
        this._pauseSequence = 0;
        this._resumeRequested = false;
        this._resumeInFlight = false;
    }

    _isEnabled() {
        return this._settings.get_boolean("exclusive-playback");
    }

    _shouldAutoResume() {
        return (
            this._isEnabled() &&
            this._settings.get_boolean("exclusive-playback-auto-resume")
        );
    }

    enforce(playingAddress) {
        if (!this._isEnabled()) return;

        const winner = this._players.get(playingAddress);
        if (!winner?.proxy || winner.proxy.PlaybackStatus !== "Playing")
            return;

        for (const [address, entry] of this._players) {
            if (address === playingAddress || !entry.proxy) continue;
            if (entry.proxy.PlaybackStatus !== "Playing") continue;
            if (entry.proxy.CanPause === false) continue;
            if (this._pausedByUs.has(address)) continue;

            this._pausePlayer(address);
        }
    }

    async _pausePlayer(address) {
        const record = {
            sequence: ++this._pauseSequence,
            pending: true,
            confirmed: false,
        };
        this._pausedByUs.set(address, record);

        try {
            await this._sendCommand(address, "Pause");
            if (this._pausedByUs.get(address) !== record) return;

            record.pending = false;
            record.confirmed = true;

            if (this._resumeRequested) this._resumePreviousIfPossible();
        } catch (error) {
            if (this._pausedByUs.get(address) === record)
                this._pausedByUs.delete(address);
            if (typeof log === "function")
                log(`Media Label: не вдалося призупинити ${address}: ${error.message}`);
            if (this._resumeRequested) this._resumePreviousIfPossible();
        }
    }

    onPlaybackStatusChanged(address, previousStatus, currentStatus) {
        if (currentStatus === "Playing") {
            // The user or another application resumed this player. It is no
            // longer eligible for automatic restoration by this controller.
            this._pausedByUs.delete(address);
            this._resumeRequested = false;
            return;
        }

        if (currentStatus === "Paused" && this._pausedByUs.has(address)) {
            if (this._resumeRequested) this._resumePreviousIfPossible();
            return;
        }

        if (previousStatus === "Playing" && currentStatus === "Stopped")
            this._requestResume();
    }

    onPlayerRemoved(address, wasPlaying) {
        this._pausedByUs.delete(address);
        if (wasPlaying) this._requestResume();
    }

    onSettingsChanged() {
        // Disabling exclusive playback must not unexpectedly start audio.
        if (!this._isEnabled()) {
            this._pausedByUs.clear();
            this._resumeRequested = false;
        }
    }

    _requestResume() {
        if (!this._shouldAutoResume()) {
            this._resumeRequested = false;
            return;
        }

        this._resumeRequested = true;
        this._resumePreviousIfPossible();
    }

    _hasPlayingPlayer() {
        for (const entry of this._players.values()) {
            if (entry.proxy?.PlaybackStatus === "Playing") return true;
        }
        return false;
    }

    async _resumePreviousIfPossible() {
        if (
            !this._resumeRequested ||
            !this._shouldAutoResume() ||
            this._resumeInFlight ||
            this._hasPlayingPlayer()
        )
            return;

        const candidates = [...this._pausedByUs.entries()].sort(
            (a, b) => b[1].sequence - a[1].sequence,
        );

        for (const [address, record] of candidates) {
            const proxy = this._players.get(address)?.proxy;

            if (!proxy || proxy.PlaybackStatus !== "Paused") {
                this._pausedByUs.delete(address);
                continue;
            }

            // Wait for the Pause method to complete before issuing Play.
            if (record.pending || !record.confirmed) return;

            if (proxy.CanPlay === false) {
                this._pausedByUs.delete(address);
                continue;
            }

            this._pausedByUs.delete(address);
            this._resumeRequested = false;
            this._resumeInFlight = true;

            try {
                await this._sendCommand(address, "Play");
            } catch (error) {
                if (
                    this._isEnabled() &&
                    this._players.get(address)?.proxy?.PlaybackStatus === "Paused"
                ) {
                    this._pausedByUs.set(address, record);
                    this._resumeRequested = true;
                }
                this._resumeRequested = false;
                if (typeof log === "function")
                    log(`Media Label: не вдалося відновити ${address}: ${error.message}`);
            } finally {
                this._resumeInFlight = false;
                if (this._resumeRequested) this._resumePreviousIfPossible();
            }
            return;
        }

        this._resumeRequested = false;
    }

    destroy() {
        this._pausedByUs.clear();
        this._players = null;
        this._settings = null;
        this._sendCommand = null;
        this._resumeRequested = false;
    }
}
