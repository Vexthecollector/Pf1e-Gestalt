/** Return PF1e's mutable level-up state across its FormApplication and
 * ApplicationV2 implementations. */
export function getLevelUpState(app) {
  return app?.levelUp ?? app?.config ?? null;
}

/** Return the temporary actor used by PF1e to preview a level-up. */
export function getLevelUpSimulacra(app) {
  return app?._simulacra ?? app?.simulacra ?? null;
}

/** Read PF1e's readiness check, which changed from a method to a getter. */
export function isLevelUpReady(app) {
  return typeof app?.isReady === "function" ? app.isReady() : Boolean(app?.isReady);
}

/** PF1e 11.11 disables favored-class choices whenever its unmodified preview
 * gains no hit die. Gestalt catch-up levels intentionally gain their FCB even
 * though the actor already has the paired gestalt hit die. */
export function allowCatchUpFavoredClass(app, state = getLevelUpState(app)) {
  if (!state?.fcb || typeof app?.isFavouredClass !== "function" || !app.isFavouredClass()) return false;
  const changed = state.fcb.available !== true || state.fcb.unavailable !== false;
  state.fcb.available = true;
  state.fcb.unavailable = false;
  return changed;
}
