/**
 * Service that monitors Claude hook installation status and drives a
 * warning banner in the webview when hooks are not configured.
 *
 * Polls ~/.claude/settings.json and ~/.claude/settings.local.json every 10s.
 * Auto-dismisses when hooks are detected or the user accepts the
 * acceptNoResumeHooks setting.
 */
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const POLL_INTERVAL_MS = 10_000;
const HOOK_SCRIPT_PATH = path.join(os.homedir(), ".work-terminal", "hooks", "session-change.sh");

export interface HookBannerState {
  visible: boolean;
  message: string;
}

type StateCallback = (state: HookBannerState) => void;

export class HookBannerService {
  private _timer: ReturnType<typeof setInterval> | null = null;
  private _dismissed = false;
  private _onStateChanged: StateCallback | null = null;
  private _lastVisible: boolean | null = null;
  private _acceptNoResumeHooks = false;

  /**
   * Register a callback that fires when the banner visibility changes.
   */
  onStateChanged(cb: StateCallback): void {
    this._onStateChanged = cb;
  }

  /**
   * Start polling hook status. Call once after the webview is ready.
   */
  start(acceptNoResumeHooks: boolean): void {
    this._acceptNoResumeHooks = acceptNoResumeHooks;
    this._check();
    this._timer = setInterval(() => this._check(), POLL_INTERVAL_MS);
  }

  /**
   * Update the acceptNoResumeHooks setting (called when settings change).
   */
  updateAcceptSetting(acceptNoResumeHooks: boolean): void {
    this._acceptNoResumeHooks = acceptNoResumeHooks;
    this._check();
  }

  /**
   * User dismissed the banner manually.
   */
  dismiss(): void {
    this._dismissed = true;
    this._emit({ visible: false, message: "" });
  }

  /**
   * Force an immediate re-check (e.g. after install/remove).
   * Clears any manual dismissal so the banner can reappear if hooks were removed.
   */
  recheckNow(): void {
    this._dismissed = false;
    this._check();
  }

  /**
   * Stop polling. Call on dispose.
   */
  dispose(): void {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    this._onStateChanged = null;
  }

  private _check(): void {
    if (this._dismissed || this._acceptNoResumeHooks) {
      if (this._lastVisible !== false) {
        this._emit({ visible: false, message: "" });
      }
      return;
    }

    const hooksFound = this._detectHooks();
    const visible = !hooksFound;

    if (visible !== this._lastVisible) {
      this._emit({
        visible,
        message: visible
          ? "Claude resume tracking requires hooks to be installed. Session resume will not work without them."
          : "",
      });
    }
  }

  private _emit(state: HookBannerState): void {
    this._lastVisible = state.visible;
    this._onStateChanged?.(state);
  }

  /**
   * Check if the work-terminal hook script exists AND is referenced in
   * Claude's global settings (~/.claude/settings.json or settings.local.json).
   */
  private _detectHooks(): boolean {
    if (!fs.existsSync(HOOK_SCRIPT_PATH)) {
      return false;
    }

    // Check global Claude settings
    const claudeDir = path.join(os.homedir(), ".claude");
    for (const filename of ["settings.json", "settings.local.json"]) {
      const settingsPath = path.join(claudeDir, filename);
      if (this._settingsContainHook(settingsPath)) {
        return true;
      }
    }

    return false;
  }

  private _settingsContainHook(settingsPath: string): boolean {
    if (!fs.existsSync(settingsPath)) return false;
    try {
      const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
      const hooks = settings?.hooks;
      if (!hooks) return false;
      return !!(
        hooks.SessionEnd?.length &&
        hooks.SessionStart?.length &&
        JSON.stringify(hooks.SessionEnd).includes(HOOK_SCRIPT_PATH) &&
        JSON.stringify(hooks.SessionStart).includes(HOOK_SCRIPT_PATH)
      );
    } catch {
      return false;
    }
  }
}
