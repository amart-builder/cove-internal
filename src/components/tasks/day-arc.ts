export type DayArcPoint = { x: number; y: number };

export type CubicDayArc = {
  start: DayArcPoint;
  controlOne: DayArcPoint;
  controlTwo: DayArcPoint;
  end: DayArcPoint;
};

export const CURRENT_DAY_ARC: CubicDayArc = {
  start: { x: 18, y: 112 },
  controlOne: { x: 116, y: 116 },
  controlTwo: { x: 244, y: 76 },
  end: { x: 306, y: 18 },
};

export const TODAY2_DAY_ARC: CubicDayArc = {
  start: { x: 8, y: 104 },
  controlOne: { x: 58, y: 46 },
  controlTwo: { x: 134, y: 17 },
  end: { x: 274, y: 28 },
};

export function getDayProgress(date: Date): number {
  const minutes = date.getHours() * 60 + date.getMinutes();
  const start = 6 * 60;
  const end = 22 * 60;
  return Math.max(0, Math.min(1, (minutes - start) / (end - start)));
}

export function pointOnCubicDayArc(
  progress: number,
  arc: CubicDayArc,
): DayArcPoint {
  const t = Number.isFinite(progress) ? Math.max(0, Math.min(1, progress)) : 0;
  const inverse = 1 - t;
  // Rounded so the server and client render byte-identical cx/cy attributes;
  // raw float math drifts in the last digit and trips React hydration.
  const round = (value: number) => Math.round(value * 100) / 100;
  return {
    x: round(
      inverse ** 3 * arc.start.x +
        3 * inverse ** 2 * t * arc.controlOne.x +
        3 * inverse * t ** 2 * arc.controlTwo.x +
        t ** 3 * arc.end.x,
    ),
    y: round(
      inverse ** 3 * arc.start.y +
        3 * inverse ** 2 * t * arc.controlOne.y +
        3 * inverse * t ** 2 * arc.controlTwo.y +
        t ** 3 * arc.end.y,
    ),
  };
}
