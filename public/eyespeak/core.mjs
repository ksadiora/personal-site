export const LETTER_GROUPS = ['ABC', 'DEF', 'GHI', 'JKL', 'MNO', 'PQR', 'STU', 'VWX', 'YZ'];

export function lettersForGroup(group) {
  return LETTER_GROUPS.includes(group) ? [...group] : [];
}

export function deleteCharacter(text) {
  return text.slice(0, -1);
}

export class DwellSelector {
  constructor({ dwellMs = 900, graceMs = 220, cooldownMs = 650 } = {}) {
    this.options = { dwellMs, graceMs, cooldownMs };
    this.reset();
  }

  reset() {
    this.targetId = null;
    this.startedAt = 0;
    this.lostAt = 0;
    this.readyAt = 0;
  }

  // The board re-renders under the gaze after every selection, so without a
  // cooldown whichever tile lands under the orb fires straight away.
  hold(now, cooldownMs = this.options.cooldownMs) {
    this.reset();
    this.readyAt = now + cooldownMs;
  }

  progress(now) {
    if (!this.targetId) return 0;
    return Math.min(1, (now - this.startedAt) / this.options.dwellMs);
  }

  update(targetId, now) {
    if (now < this.readyAt) return { progress: 0, fired: false };
    if (!targetId) {
      if (!this.targetId) return { progress: 0, fired: false };
      // A gaze point that wobbles into the gap between two tiles should not
      // throw away a hold the user has already most of the way finished.
      if (!this.lostAt) this.lostAt = now;
      if (now - this.lostAt <= this.options.graceMs) return { progress: this.progress(now), fired: false };
      this.reset();
      return { progress: 0, fired: false };
    }
    if (targetId !== this.targetId) {
      this.targetId = targetId;
      this.startedAt = now;
      this.lostAt = 0;
      return { progress: 0, fired: false };
    }
    this.lostAt = 0;
    const progress = this.progress(now);
    if (progress < 1) return { progress, fired: false };
    this.hold(now);
    return { progress: 1, fired: true };
  }
}
