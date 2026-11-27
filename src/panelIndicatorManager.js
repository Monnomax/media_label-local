import * as Main from "resource:///org/gnome/shell/ui/main.js";
import { MediaPlayerIndicator } from "./mediaPlayerIndicator.js";

export class PanelIndicatorManager {
    constructor(extension) {
        this._extension = extension;
        this._settings = extension.getSettings();
        this._indicator = null;
        this._positionChangedId = null;
        this._indexChangedId = null;
    }

    enable() {
        this._positionChangedId = this._settings.connect(
            "changed::panel-position",
            () => this._rebuildIndicator(),
        );

        this._indexChangedId = this._settings.connect(
            "changed::panel-index",
            () => this._rebuildIndicator(),
        );

        this._rebuildIndicator();
    }

    _rebuildIndicator() {
        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }

        const positionIndex = this._settings.get_int("panel-position");
        const panelIndex = this._settings.get_int("panel-index");
        const positions = ["left", "center", "right"];
        const targetBox = positions[positionIndex] || "center";

        this._indicator = new MediaPlayerIndicator(this._extension);

        Main.panel.addToStatusArea(
            this._extension.uuid,
            this._indicator,
            panelIndex,
            targetBox,
        );
    }

    disable() {
        if (this._positionChangedId !== null)
            this._settings.disconnect(this._positionChangedId);
        if (this._indexChangedId !== null)
            this._settings.disconnect(this._indexChangedId);

        this._positionChangedId = null;
        this._indexChangedId = null;

        this._indicator?.destroy();
        this._indicator = null;
        this._settings = null;
        this._extension = null;
    }
}
