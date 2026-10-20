import { t } from "../strings.ts";

const heading = "mb-3 text-sm font-bold uppercase tracking-widest text-text-3";

/**
 * Under the start button: how it works, and the questions a first visit asks. It is part of the
 * prerendered page, so crawlers that run no script read it too.
 */
export function About() {
  return (
    <div className="flex flex-col gap-8 border-t border-line pt-8">
      <section aria-labelledby="about-how">
        <h2 id="about-how" className={heading}>
          {t.about.how}
        </h2>
        <ol className="flex flex-col gap-4">
          {t.about.steps.map((s, i) => (
            <li key={s.title} className="flex gap-3">
              <span
                aria-hidden="true"
                className="flex size-8 shrink-0 items-center justify-center rounded-full bg-surface font-black text-profile"
              >
                {i + 1}
              </span>
              <div>
                <h3 className="font-bold">{s.title}</h3>
                <p className="text-sm leading-relaxed text-text-2">{s.body}</p>
                {s.link && (
                  <a
                    href={s.link.href}
                    className="mt-1 inline-block text-sm font-semibold underline underline-offset-4"
                  >
                    {s.link.text}
                  </a>
                )}
              </div>
            </li>
          ))}
        </ol>
      </section>

      <section aria-labelledby="about-faq">
        <h2 id="about-faq" className={heading}>
          {t.about.faq}
        </h2>
        <dl className="flex flex-col gap-4">
          {t.about.questions.map(({ q, a }) => (
            <div key={q}>
              <dt className="font-bold">{q}</dt>
              <dd className="text-sm leading-relaxed text-text-2">{a}</dd>
            </div>
          ))}
        </dl>
      </section>
    </div>
  );
}
