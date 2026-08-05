const EASE_OUT = 'cubic-bezier(.2,.78,.22,1)';
const STRONG_EASE_OUT = 'cubic-bezier(.23,1,.32,1)';
export const TODAY2_MOTION_WATCHDOG_MS = 3000;

export type Today2MotionOutcome = 'finished' | 'watchdog' | 'cancelled';

export class Today2MotionDataTimeoutError extends Error {
  constructor() {
    super('Today motion data operation timed out.');
    this.name = 'Today2MotionDataTimeoutError';
  }
}

type MotionRun = {
  finished: Promise<Today2MotionOutcome>;
  cancel: () => void;
  expire: () => void;
  cleanup: () => void;
};

type CompletionMotionInput = {
  layer: HTMLElement;
  completedTemplate: HTMLElement;
  completedRect: DOMRect;
  doneRect: DOMRect;
  refillTemplate?: HTMLElement;
  refillRect?: DOMRect;
  riverStartY: number;
  onMerge: () => void;
  onWatchdog?: () => void;
};

type UndoMotionInput = {
  layer: HTMLElement;
  displacedTemplate?: HTMLElement;
  restoredTemplate: HTMLElement;
  seatRect: DOMRect;
  doneRect: DOMRect;
  riverTarget: { x: number; y: number };
  onDetach: () => void;
  onWatchdog?: () => void;
};

export function createToday2MotionWatchdog(
  visualFinished: Promise<void>,
  onWatchdog: () => void,
  timeoutMs = TODAY2_MOTION_WATCHDOG_MS,
): {
  finished: Promise<Today2MotionOutcome>;
  cancel: () => void;
  expire: () => void;
} {
  let settled = false;
  let resolveFinished: (outcome: Today2MotionOutcome) => void = () => undefined;
  const finished = new Promise<Today2MotionOutcome>((resolve) => {
    resolveFinished = resolve;
  });
  const settle = (outcome: Today2MotionOutcome) => {
    if (settled) return;
    settled = true;
    globalThis.clearTimeout(timer);
    resolveFinished(outcome);
  };
  const expire = () => {
    if (settled) return;
    onWatchdog();
    settle('watchdog');
  };
  const timer = globalThis.setTimeout(expire, timeoutMs);
  void visualFinished.then(
    () => settle('finished'),
    () => settle('cancelled'),
  );
  return {
    finished,
    cancel: () => settle('cancelled'),
    expire,
  };
}

export function boundToday2MotionData<T>(
  data: Promise<T>,
  timeoutMs = TODAY2_MOTION_WATCHDOG_MS,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const settle = (action: () => void) => {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timer);
      action();
    };
    const timer = globalThis.setTimeout(
      () => settle(() => reject(new Today2MotionDataTimeoutError())),
      timeoutMs,
    );
    void data.then(
      (value) => settle(() => resolve(value)),
      (error: unknown) => settle(() => reject(error)),
    );
  });
}

function waitFor(animation: Animation): Promise<void> {
  return animation.finished.then(() => undefined, () => undefined);
}

function fixedClone(layer: HTMLElement, template: HTMLElement, rect: DOMRect): HTMLElement {
  const clone = template.cloneNode(true) as HTMLElement;
  clone.removeAttribute('id');
  clone.removeAttribute('role');
  clone.removeAttribute('tabindex');
  clone.removeAttribute('aria-expanded');
  clone.removeAttribute('data-today2-task-id');
  clone.classList.remove('is-selected', 'is-completing');
  clone.classList.add('today2-motion-card');
  clone.querySelectorAll<HTMLElement>('button, a, [tabindex]').forEach((element) => {
    element.removeAttribute('id');
    element.tabIndex = -1;
  });
  Object.assign(clone.style, {
    position: 'fixed',
    left: `${rect.left}px`,
    top: `${rect.top}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
    minHeight: '0',
    margin: '0',
  });
  layer.appendChild(clone);
  return clone;
}

function quadraticFrames(
  dx: number,
  dy: number,
  controlX: number,
  controlY: number,
  scaleFrom: number,
  scaleTo: number,
  opacityTo: number,
): Keyframe[] {
  return [0, .2, .4, .6, .8, 1].map((time) => {
    const progress = 1 - Math.pow(1 - time, 3);
    const inverse = 1 - progress;
    const x = 2 * inverse * progress * controlX + progress * progress * dx;
    const y = 2 * inverse * progress * controlY + progress * progress * dy;
    return {
      offset: time,
      transform: `translate3d(${x}px, ${y}px, 0) scale(${scaleFrom + (scaleTo - scaleFrom) * progress})`,
      opacity: 1 + (opacityTo - 1) * Math.max(0, (progress - .12) / .88),
      borderRadius: `${20 + progress * 30}px`,
    };
  });
}

function addRipple(layer: HTMLElement, rect: DOMRect): HTMLElement {
  const ripple = document.createElement('span');
  ripple.className = 'today2-motion-ripple';
  ripple.style.left = `${rect.left + rect.width / 2}px`;
  ripple.style.top = `${rect.top + rect.height / 2}px`;
  ripple.innerHTML = '<i></i><i></i><i></i>';
  layer.appendChild(ripple);
  return ripple;
}

export function prefersToday2ReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function beginCompletionMotion(input: CompletionMotionInput): MotionRun {
  let cancelled = false;
  const nodes: HTMLElement[] = [];
  const animations: Animation[] = [];
  const timers = new Map<number, () => void>();
  const delay = (milliseconds: number) => new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      timers.delete(timer);
      resolve();
    };
    const timer = window.setTimeout(() => {
      finish();
    }, milliseconds);
    timers.set(timer, finish);
  });

  const completed = fixedClone(input.layer, input.completedTemplate, input.completedRect);
  nodes.push(completed);
  completed.classList.add('is-completing', 'is-confirming');
  const confirm = completed.animate([
    { transform: 'scale(1)', offset: 0 },
    { transform: 'scale(1.03)', offset: 1 },
  ], { duration: 90, easing: EASE_OUT, fill: 'forwards' });
  animations.push(confirm);

  const visualFinished = (async () => {
    await waitFor(confirm);
    if (cancelled) return;
    completed.classList.remove('is-confirming');
    const dx = input.doneRect.left + input.doneRect.width / 2
      - (input.completedRect.left + input.completedRect.width / 2);
    const dy = input.doneRect.top + input.doneRect.height / 2
      - (input.completedRect.top + input.completedRect.height / 2);
    const controlX = dx * .72 + (Math.abs(dx) < 8 ? 14 : 0);
    const controlY = dy * .42 - 22;
    const flow = completed.animate(
      quadraticFrames(dx, dy, controlX, controlY, 1.03, .2, .18),
      { duration: 460, easing: 'linear', fill: 'forwards' },
    );
    animations.push(flow);

    const refill = input.refillTemplate && input.refillRect
      ? (async () => {
          await delay(120);
          if (cancelled || !input.refillTemplate || !input.refillRect) return;
          const ghost = fixedClone(input.layer, input.refillTemplate, input.refillRect);
          nodes.push(ghost);
          ghost.classList.add('is-refill');
          const content = ghost.querySelector<HTMLElement>('.today2-focus-copy');
          if (content) {
            content.style.opacity = '0';
            content.style.transform = 'translateY(4px)';
          }
          const startY = input.riverStartY - (input.refillRect.top + input.refillRect.height / 2);
          const rise = ghost.animate([
            { transform: `translate3d(0, ${startY}px, 0) scale(.6)`, opacity: .44 },
            { transform: 'translate3d(0, 0, 0) scale(1)', opacity: 1 },
          ], { duration: 400, easing: EASE_OUT, fill: 'forwards' });
          animations.push(rise);
          const contentDelay = delay(260).then(async () => {
            if (cancelled || !content) return;
            const contentIn = content.animate([
              { opacity: 0, transform: 'translateY(4px)' },
              { opacity: 1, transform: 'translateY(0)' },
            ], { duration: 140, easing: STRONG_EASE_OUT, fill: 'forwards' });
            animations.push(contentIn);
            await waitFor(contentIn);
          });
          await Promise.all([waitFor(rise), contentDelay]);
        })()
      : Promise.resolve();

    await waitFor(flow);
    if (cancelled) return;
    const ripple = addRipple(input.layer, input.doneRect);
    nodes.push(ripple);
    input.onMerge();
    const rippleAnimation = ripple.animate([
      { opacity: .9, transform: 'translate(-50%, -50%) scale(.28)' },
      { opacity: 0, transform: 'translate(-50%, -50%) scale(.9)' },
    ], { duration: 340, easing: EASE_OUT, fill: 'forwards' });
    animations.push(rippleAnimation);
    await Promise.all([refill, waitFor(rippleAnimation)]);
  })();

  const cleanup = () => nodes.forEach((node) => node.remove());
  const stopVisuals = () => {
    cancelled = true;
    timers.forEach((finish, timer) => {
      window.clearTimeout(timer);
      finish();
    });
    timers.clear();
    animations.forEach((animation) => animation.cancel());
    cleanup();
  };
  const watchdog = createToday2MotionWatchdog(visualFinished, () => {
    stopVisuals();
    input.onWatchdog?.();
  });

  return {
    finished: watchdog.finished,
    cancel: () => {
      stopVisuals();
      watchdog.cancel();
    },
    expire: watchdog.expire,
    cleanup,
  };
}

export function beginUndoMotion(input: UndoMotionInput): MotionRun {
  let cancelled = false;
  const nodes: HTMLElement[] = [];
  const animations: Animation[] = [];

  const restored = fixedClone(input.layer, input.restoredTemplate, input.seatRect);
  nodes.push(restored);
  restored.style.opacity = '0';

  let sinkFinished = Promise.resolve();
  if (input.displacedTemplate) {
    const displaced = fixedClone(input.layer, input.displacedTemplate, input.seatRect);
    nodes.push(displaced);
    const fromX = input.seatRect.left + input.seatRect.width / 2;
    const fromY = input.seatRect.top + input.seatRect.height / 2;
    const dx = input.riverTarget.x - fromX;
    const dy = input.riverTarget.y - fromY;
    const sink = displaced.animate(
      quadraticFrames(dx, dy, dx * .7, dy * .46 + 16, 1, .12, .08),
      { duration: 280, easing: 'linear', fill: 'forwards' },
    );
    animations.push(sink);
    sinkFinished = waitFor(sink);
  }

  const visualFinished = (async () => {
    await sinkFinished;
    if (cancelled) return;
    const ripple = addRipple(input.layer, input.doneRect);
    nodes.push(ripple);
    input.onDetach();
    const markerX = input.doneRect.left + input.doneRect.width / 2;
    const markerY = input.doneRect.top + input.doneRect.height / 2;
    const seatX = input.seatRect.left + input.seatRect.width / 2;
    const seatY = input.seatRect.top + input.seatRect.height / 2;
    const dx = markerX - seatX;
    const dy = markerY - seatY;
    const reform = restored.animate([
      { transform: `translate3d(${dx}px, ${dy}px, 0) scale(.2)`, opacity: .12, filter: 'blur(2px)', borderRadius: '50%' },
      { transform: 'translate3d(0, 0, 0) scale(1)', opacity: 1, filter: 'blur(0)', borderRadius: '20px' },
    ], { duration: 440, easing: EASE_OUT, fill: 'forwards' });
    const rippleAnimation = ripple.animate([
      { opacity: .82, transform: 'translate(-50%, -50%) scale(.25)' },
      { opacity: 0, transform: 'translate(-50%, -50%) scale(1.08)' },
    ], { duration: 440, easing: EASE_OUT, fill: 'forwards' });
    animations.push(reform, rippleAnimation);
    await Promise.all([waitFor(reform), waitFor(rippleAnimation)]);
  })();

  const cleanup = () => nodes.forEach((node) => node.remove());
  const stopVisuals = () => {
    cancelled = true;
    animations.forEach((animation) => animation.cancel());
    cleanup();
  };
  const watchdog = createToday2MotionWatchdog(visualFinished, () => {
    stopVisuals();
    input.onWatchdog?.();
  });

  return {
    finished: watchdog.finished,
    cancel: () => {
      stopVisuals();
      watchdog.cancel();
    },
    expire: watchdog.expire,
    cleanup,
  };
}

export function hideToday2Seat(band: HTMLElement, seatIndex: number): () => void {
  const hidden = new Set<HTMLElement>();
  const hide = () => {
    const unit = band.querySelectorAll<HTMLElement>('[data-today2-focus-unit]')[seatIndex];
    const card = unit?.querySelector<HTMLElement>('.today2-focus-card');
    if (!card || card.classList.contains('today2-motion-card')) return;
    card.style.visibility = 'hidden';
    hidden.add(card);
  };
  hide();
  const observer = new MutationObserver(hide);
  observer.observe(band, { childList: true, subtree: true });
  return () => {
    observer.disconnect();
    hidden.forEach((card) => card.style.removeProperty('visibility'));
    const unit = band.querySelectorAll<HTMLElement>('[data-today2-focus-unit]')[seatIndex];
    unit?.querySelector<HTMLElement>('.today2-focus-card')?.style.removeProperty('visibility');
  };
}
