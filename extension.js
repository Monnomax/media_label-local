import { Extension } from "resource:///org/gnome/shell/extensions/extension.js";
import { PanelIndicatorManager } from "./src/panelIndicatorManager.js";

export default class FlatMediaPlayerExtension extends Extension {
    enable() {
        this._panelIndicatorManager = new PanelIndicatorManager(this);
        this._panelIndicatorManager.enable();
    }

    disable() {
        this._panelIndicatorManager?.disable();
        this._panelIndicatorManager = null;
    }
}
