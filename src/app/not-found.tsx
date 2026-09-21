import Link from 'next/link';

// Without this file Next renders its own 404, and its shell sets the page's
// colours itself: measured in a browser, the `dark` class was gone from <html>
// and the body came back pure white while the nav above it stayed dark, so a
// mistyped or stale address threw a half-light, half-dark page at you. Cove's
// own page inherits the theme like every other screen, and says the one useful
// thing instead of a status code.
export default function NotFound() {
  return (
    <div className="flex h-full items-center justify-center p-8">
      <div className="max-w-sm text-center">
        <h1 className="text-base font-semibold text-foreground">
          There is nothing at this address.
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          The page may have been renamed, or the link may be out of date.
        </p>
        <Link
          href="/"
          className="mt-5 inline-block rounded-full border px-4 py-2 text-sm text-foreground hover:bg-muted"
        >
          Back to Today
        </Link>
      </div>
    </div>
  );
}
