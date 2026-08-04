export type ArrivalStep = 'brief' | 'plan';

const STEP_LABELS: Record<ArrivalStep, string> = {
  brief: 'The brief',
  plan: 'Plan your day',
};

export function morningArrivalSteps(): ArrivalStep[] {
  return ['brief', 'plan'];
}

export default function StepDots({
  steps,
  activeStep,
}: {
  steps: readonly ArrivalStep[];
  activeStep: ArrivalStep;
}) {
  return (
    <ol className="flex items-center gap-2" aria-label="Briefing progress">
      {steps.map((step, index) => (
        <li
          key={step}
          className="flex items-center"
          aria-current={step === activeStep ? 'step' : undefined}
        >
          <span
            className={`block size-1.5 rounded-full ${
              step === activeStep ? 'bg-foreground' : 'bg-muted-foreground/30'
            }`}
            aria-hidden="true"
          />
          <span className="sr-only">
            Step {index + 1} of {steps.length}: {STEP_LABELS[step]}
            {step === activeStep ? ' (current)' : ''}
          </span>
        </li>
      ))}
    </ol>
  );
}
