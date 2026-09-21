import { getRuntimeMode, type RuntimeMode } from "@/lib/runtime/mode";

const BASE_MOMENTS = [
  {
    number: "1",
    title: "Arrival",
    text: "Open Today at the start of work. Read the brief, put your top work in order, choose who owns it, and start your day.",
  },
  {
    number: "2",
    title: "Work the day",
    text: "Keep one clear focus in the middle. New email, meeting notes, and ideas can flow in without taking over. If plans change, tell Buddy: “New urgent thing, reshuffle my afternoon.” Review the preview, then tap Apply.",
  },
  {
    number: "3",
    title: "Closing your day",
    text: "Take two minutes to say what moved, what stays open, and what can wait. This keeps tomorrow clean.",
  },
];

const words = [
  ["Today", "Your main view for the work in front of you."],
  ["The current", "The flow of work on Today. The middle is your main focus."],
  ["Arrival", "The short morning start."],
  ["The brief", "A morning note about what matters and what changed."],
  ["Still open", "Work or promises that are not done yet."],
  ["Closing your day", "The short end of day check."],
  ["Buddy", "The command bar for Cove actions and help."],
  ["Issues", "Work Cove could not finish and needs you to look."],
  ["Recent activity", "A plain list of what Cove finished for you."],
];

export function guideCopyForRuntime(mode: RuntimeMode) {
  const local = mode === "local";
  return {
    moments: BASE_MOMENTS.map((moment) =>
      moment.number === "2" && !local
        ? {
            ...moment,
            text: "Keep one clear focus in the middle. New email, meeting notes, and ideas can flow in without taking over.",
          }
        : moment
    ),
    words: local
      ? words
      : words.filter(([word]) => word !== "Recent activity"),
    showFeedback: local,
  };
}

export default function GuidePage({ dataFolder }: { dataFolder?: string }) {
  const copy = guideCopyForRuntime(getRuntimeMode());
  return (
    <div className="h-full overflow-y-auto bg-background">
      <div className="relative mx-auto max-w-4xl px-5 pb-10 pt-[72px] sm:px-8 sm:pb-14 sm:pt-[80px]">
        <div
          className="pointer-events-none absolute inset-x-8 top-5 h-64 rounded-full bg-accent-blue/5 blur-3xl"
          aria-hidden="true"
        />
        <header className="relative max-w-2xl">
          <p className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">
            Cove guide
          </p>
          <h1 className="mt-3 text-3xl font-semibold tracking-[-0.04em] text-foreground sm:text-4xl">
            A calm day, from start to close
          </h1>
          <p className="mt-4 text-base leading-7 text-muted-foreground">
            Cove helps you choose what matters, keep new work from getting lost, and end the day with a clean plan.
          </p>
        </header>

        <section className="relative mt-10" aria-labelledby="daily-moments">
          <h2 id="daily-moments" className="text-lg font-semibold tracking-[-0.02em] text-foreground">
            The three daily moments
          </h2>
          <div className="mt-5 grid gap-4 md:grid-cols-3">
            {copy.moments.map((moment) => (
              <article
                key={moment.number}
                className="rounded-2xl border border-accent-blue/15 bg-card/80 p-5 shadow-sm backdrop-blur"
              >
                <span className="grid size-8 place-items-center rounded-full bg-accent-blue/10 text-sm font-semibold text-accent-blue">
                  {moment.number}
                </span>
                <h3 className="mt-4 text-base font-semibold text-foreground">{moment.title}</h3>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">{moment.text}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="mt-12 grid gap-8 lg:grid-cols-[1.1fr_0.9fr]">
          <div>
            <h2 className="text-lg font-semibold tracking-[-0.02em] text-foreground">
              Words Cove uses
            </h2>
            <dl className="mt-4 divide-y divide-border overflow-hidden rounded-2xl border border-border bg-card/75">
              {copy.words.map(([word, meaning]) => (
                <div key={word} className="grid gap-1 px-5 py-4 sm:grid-cols-[9rem_1fr] sm:gap-4">
                  <dt className="text-sm font-semibold text-foreground">{word}</dt>
                  <dd className="text-sm leading-6 text-muted-foreground">{meaning}</dd>
                </div>
              ))}
            </dl>
          </div>

          <div className="space-y-5">
            {dataFolder && (
              <article className="rounded-2xl border border-border bg-card/75 p-5">
                <h2 className="text-base font-semibold text-foreground">
                  Where your work is kept
                </h2>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">
                  Everything Cove knows sits in one folder on this Mac:{" "}
                  <span className="break-all font-mono text-xs text-foreground">{dataFolder}</span>. There is no Cove
                  account and no Cove server holding a copy, and Cove is installed to answer only on this Mac, so
                  nothing else on your network can open it.
                </p>
                <p className="mt-3 text-sm leading-6 text-muted-foreground">
                  Two things do leave the Mac, and only for the features you turn on: the model provider you chose is
                  sent the text it needs to write your brief and sort your inbox, and Google is sent the requests Cove
                  makes for your mail and calendar.
                </p>
              </article>
            )}

            <article className="rounded-2xl border border-border bg-card/75 p-5">
              <h2 className="text-base font-semibold text-foreground">
                When your Mac is closed
              </h2>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">
                On one laptop, Cove works only while the Mac is open and awake. If the lid is closed, inbox checks, meeting notes, reminders, and other background work wait. They catch up after you wake the Mac. A Mac Mini that stays awake can run those jobs all day and night.
              </p>
            </article>

            <article className="rounded-2xl border border-border bg-card/75 p-5">
              <h2 className="text-base font-semibold text-foreground">
                Ask Buddy for help
              </h2>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">
                Try: “How do I close my day?”, “How do I change an owner?”, or “Why did my inbox check not run?” Buddy stays focused on Cove and its work.
              </p>
              {copy.showFeedback && (
                <p className="mt-3 text-sm leading-6 text-muted-foreground">
                  To share a bug or idea, say: “Send feedback: the text on this card is hard to read.” Buddy makes a Gmail draft. You review and send it yourself.
                </p>
              )}
            </article>
          </div>
        </section>
      </div>
    </div>
  );
}
