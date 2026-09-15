/** Keep dynamic header controls and the selected work in separate vertical space. */
export function todayStageLayout(input: {
  width: number;
  height: number;
  headerBottom: number;
  focusHeight: number;
  secondCurrentHeight: number;
  focusCount: number;
}) {
  const narrow = input.width <= 850;
  const gap = 24;
  const focusGap = narrow ? 64 : gap;
  const footerSpace = 130;
  const secondFraction = input.height <= 720 ? .19 : .205;
  const focusFraction = input.width <= 1180 && input.focusCount === 3
    ? .47 : input.height <= 720 ? .46 : .435;
  const reservedTop = input.headerBottom + (narrow ? gap + input.secondCurrentHeight : 0);
  const contentHeight = Math.ceil(Math.max(
    input.height,
    input.height <= 720 ? 560 : 620,
    reservedTop + focusGap + input.focusHeight + footerSpace,
    narrow ? 0 : (input.secondCurrentHeight + gap + input.focusHeight + footerSpace) / (1 - secondFraction),
  ));
  const secondTop = narrow ? input.headerBottom + gap : contentHeight * secondFraction;
  const focusTop = Math.ceil(Math.max(
    contentHeight * focusFraction - input.focusHeight / 2,
    input.headerBottom + gap,
    secondTop + input.secondCurrentHeight + focusGap,
  ));
  const doneTop = narrow ? secondTop + input.secondCurrentHeight + 16 : contentHeight * .225;
  return { contentHeight, focusTop, secondTop, doneTop };
}
