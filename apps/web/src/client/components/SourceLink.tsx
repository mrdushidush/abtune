import { t } from "../strings.ts";

export const REPO_URL = "https://github.com/mrdushidush/abtune";

/** "Open source on GitHub ★", in the footers. */
export function SourceLink() {
  return (
    <a
      href={REPO_URL}
      target="_blank"
      rel="noopener noreferrer"
      className="font-semibold underline hover:text-text"
    >
      {t.source} ★
    </a>
  );
}

/** "Privacy · Terms", in the footers: pages the server serves at /privacy and /terms. */
export function LegalLinks() {
  return (
    <>
      <a href="/privacy" className="underline hover:text-text">
        {t.privacy}
      </a>
      {" · "}
      <a href="/terms" className="underline hover:text-text">
        {t.terms}
      </a>
    </>
  );
}
