import { useEffect, useRef, useState } from "react";
import { type CardFormat, type CardInput, cardImage } from "../lib/card-image.ts";
import { saveBlob } from "../lib/download.ts";
import { shareUrl } from "../state/share.ts";
import { track } from "../state/stats.ts";
import { t } from "../strings.ts";

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "card";

const btn =
  "flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-xl bg-raised px-3 text-sm font-bold text-text hover:bg-line disabled:opacity-40";

/** The host a link or card names ("abtune.com"). */
const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
};

/**
 * Share ↗ (HANDOFF §4.4, M6): a link that rebuilds this card and playlist on any device, and the
 * card as a PNG. The link is a URL fragment, so opening it sends the server nothing but the usual
 * playlist request.
 */
export function ShareButton({
  code,
  card,
  name,
  baseUrl,
}: {
  /** Null until the playlist is ready. */
  code: string | null;
  card: CardInput | null;
  /** The archetype, for the share text and file name. */
  name: string;
  /** Where the link points (health `share_url`): this server's public URL or the public instance. */
  baseUrl: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        disabled={!code || !card}
        className="flex min-h-12 flex-1 items-center justify-center gap-1.5 rounded-2xl bg-raised px-4 font-bold text-text hover:bg-line disabled:opacity-40"
        onClick={() => {
          setOpen(true);
          dialog.current?.showModal();
        }}
      >
        ↗ {t.share.button}
      </button>
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: backdrop click is a mouse shortcut; keys have Escape and Close */}
      <dialog
        ref={dialog}
        aria-labelledby="share-title"
        onClose={() => setOpen(false)}
        onClick={(e) => {
          // A click on the backdrop lands on the dialog element itself.
          if (e.target === e.currentTarget) dialog.current?.close();
        }}
        className="m-auto w-[min(30rem,calc(100%-2rem))] rounded-3xl border border-line bg-surface p-0 text-text backdrop:bg-ink/80"
      >
        {open && code && card && (
          <ShareBody
            code={code}
            card={card}
            name={name}
            baseUrl={baseUrl}
            onClose={() => dialog.current?.close()}
          />
        )}
      </dialog>
    </>
  );
}

function ShareBody({
  code,
  card,
  name,
  baseUrl,
  onClose,
}: {
  code: string;
  card: CardInput;
  name: string;
  baseUrl: string;
  onClose: () => void;
}) {
  const url = shareUrl(baseUrl, code);
  const site = hostOf(url);
  const field = useRef<HTMLInputElement>(null);
  const [copy, setCopy] = useState<"idle" | "done" | "failed">("idle");
  const [format, setFormat] = useState<CardFormat>("post");
  const [image, setImage] = useState<{ blob: Blob; url: string } | null>(null);
  const [imageFailed, setImageFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    let objectUrl: string | null = null;
    setImage(null);
    setImageFailed(false);
    cardImage(site ? { ...card, site } : card, format)
      .then((blob) => {
        if (!alive) return;
        objectUrl = URL.createObjectURL(blob);
        setImage({ blob, url: objectUrl });
      })
      .catch(() => alive && setImageFailed(true));
    return () => {
      alive = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [card, site, format]);

  const file = image
    ? new File([image.blob], `abtune-${slug(name)}${format === "story" ? "-story" : ""}.png`, {
        type: "image/png",
      })
    : null;
  const canShareLink = typeof navigator.share === "function";
  const canShareFile = !!file && (navigator.canShare?.({ files: [file] }) ?? false);
  const text = t.share.shareText(name);

  const onCopy = async () => {
    track("share_link");
    try {
      await navigator.clipboard.writeText(url);
      setCopy("done");
    } catch {
      field.current?.select();
      setCopy("failed");
    }
  };
  // A dismissed share sheet rejects with AbortError: nothing to report.
  const share = (data: ShareData) => navigator.share(data).catch(() => {});

  return (
    <div className="flex flex-col gap-4 p-5">
      <header className="flex items-center justify-between gap-3">
        <h2 id="share-title" className="text-lg font-black">
          {t.share.title}
        </h2>
        <button
          type="button"
          className="rounded-lg px-2 py-1 text-sm font-semibold text-text-3 hover:text-text"
          onClick={onClose}
        >
          {t.share.close}
        </button>
      </header>

      <div className="flex flex-col gap-2">
        <label htmlFor="share-link" className="text-sm font-bold text-text-2">
          {t.share.link}
        </label>
        <input
          id="share-link"
          ref={field}
          readOnly
          value={url}
          onFocus={(e) => e.currentTarget.select()}
          className="w-full rounded-xl border border-line bg-ink px-3 py-2 font-mono text-xs text-text-2"
        />
        <div className="flex gap-2">
          <button type="button" className={btn} onClick={onCopy}>
            {copy === "done" ? `✓ ${t.share.copied}` : t.share.copy}
          </button>
          {canShareLink && (
            <button
              type="button"
              className={btn}
              onClick={() => {
                track("share_link");
                share({ title: "ABTune", text, url });
              }}
            >
              {t.share.shareLink}
            </button>
          )}
        </div>
        <p className="text-xs text-text-3" role="status">
          {copy === "failed" ? t.share.copyFailed : t.share.privacy}
          {site && site !== location.host && ` ${t.share.opensOn(site)}`}
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm font-bold text-text-2">{t.share.image}</p>
          <fieldset className="flex gap-1 rounded-xl bg-ink p-1">
            <legend className="sr-only">{t.share.image}</legend>
            {(["post", "story"] as const).map((f) => (
              <label
                key={f}
                className={`cursor-pointer rounded-lg px-2.5 py-1 text-xs font-bold has-focus-visible:ring-2 has-focus-visible:ring-profile ${
                  format === f ? "bg-raised text-text" : "text-text-3 hover:text-text"
                }`}
              >
                <input
                  type="radio"
                  name="card-format"
                  value={f}
                  checked={format === f}
                  onChange={() => setFormat(f)}
                  className="sr-only"
                />
                {t.share.formats[f]}
              </label>
            ))}
          </fieldset>
        </div>
        <div
          className={`mx-auto w-full overflow-hidden rounded-2xl bg-ink ${
            format === "story" ? "aspect-[9/16] max-w-44" : "aspect-[4/5] max-w-60"
          }`}
        >
          {image ? (
            <img src={image.url} alt={t.share.imageAlt(name)} className="size-full" />
          ) : (
            <p className="flex size-full items-center justify-center p-4 text-center text-sm text-text-3">
              {imageFailed ? t.result.actionFailed : t.share.makingImage}
            </p>
          )}
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            className={btn}
            disabled={!file}
            onClick={() => {
              if (!file) return;
              track("share_image");
              saveBlob(file, file.name);
            }}
          >
            ⬇ {t.share.saveImage}
          </button>
          {canShareFile && file && (
            <button
              type="button"
              className={btn}
              onClick={() => {
                track("share_image");
                share({ files: [file], title: "ABTune", text: `${text} ${url}` });
              }}
            >
              {t.share.shareImage}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
