// Shareable result card. Renders a square image on a canvas and shares it via
// the Web Share API (with the image file where supported), falling back to a
// text + link share, then to copying the link.

export interface ShareResult {
  result: 0 | 1 | 2; // 0 win, 1 loss, 2 draw (sharer's perspective)
  scoreMine: number;
  scoreOpp: number;
  payout?: string; // e.g. "1.95 USDC"
}

const SITE = "https://awale-on-chain.vercel.app";

function drawCard(c: ShareResult): HTMLCanvasElement {
  const S = 1080;
  const cv = document.createElement("canvas");
  cv.width = S;
  cv.height = S;
  const ctx = cv.getContext("2d")!;

  // background
  const g = ctx.createLinearGradient(0, 0, S, S);
  g.addColorStop(0, "#15201a");
  g.addColorStop(1, "#0a0d09");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);
  // ambient glow
  const win = c.result === 0;
  const rg = ctx.createRadialGradient(S / 2, S * 0.42, 60, S / 2, S * 0.42, S * 0.6);
  rg.addColorStop(0, win ? "rgba(245,196,81,0.22)" : "rgba(61,220,111,0.12)");
  rg.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = rg;
  ctx.fillRect(0, 0, S, S);

  ctx.textAlign = "center";

  // wordmark
  ctx.fillStyle = "#a6bca7";
  ctx.font = "600 44px Georgia, serif";
  ctx.fillText("A W A L É", S / 2, 150);

  // emblem
  ctx.font = "200px serif";
  ctx.fillText(win ? "🏆" : c.result === 2 ? "🤝" : "🌱", S / 2, 430);

  // headline
  ctx.fillStyle = win ? "#f5c451" : "#f1f5ef";
  ctx.font = "800 110px Georgia, serif";
  ctx.fillText(win ? "Victory" : c.result === 2 ? "Draw" : "Defeat", S / 2, 580);

  // score
  ctx.fillStyle = "#eef2ec";
  ctx.font = "800 130px ui-sans-serif, system-ui, sans-serif";
  ctx.fillText(`${c.scoreMine} – ${c.scoreOpp}`, S / 2, 740);

  // payout
  if (win && c.payout) {
    ctx.fillStyle = "#3ddc6f";
    ctx.font = "700 56px ui-sans-serif, system-ui, sans-serif";
    ctx.fillText(`Won ${c.payout}`, S / 2, 830);
  }

  // footer
  ctx.fillStyle = "#6e8470";
  ctx.font = "500 40px ui-sans-serif, system-ui, sans-serif";
  ctx.fillText("Play Awalé for stablecoin · awale-on-chain.vercel.app", S / 2, 1000);

  return cv;
}

function toBlob(cv: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((res) => cv.toBlob(res, "image/png"));
}

export async function shareResult(c: ShareResult): Promise<void> {
  const text =
    c.result === 0
      ? `I won ${c.scoreMine}–${c.scoreOpp} at Awalé${c.payout ? ` (+${c.payout})` : ""}!`
      : c.result === 2
        ? `I drew ${c.scoreMine}–${c.scoreOpp} at Awalé.`
        : `I played Awalé (${c.scoreMine}–${c.scoreOpp}). Come take me on!`;

  try {
    const blob = await toBlob(drawCard(c));
    if (blob) {
      const file = new File([blob], "awale-result.png", { type: "image/png" });
      const nav = navigator as Navigator & { canShare?: (d: unknown) => boolean };
      if (nav.canShare?.({ files: [file] }) && navigator.share) {
        await navigator.share({ files: [file], text, url: SITE });
        return;
      }
    }
  } catch {
    /* fall through to text/link share */
  }

  if (navigator.share) {
    try {
      await navigator.share({ text, url: SITE });
      return;
    } catch {
      /* user cancelled or unsupported */
    }
  }
  try {
    await navigator.clipboard?.writeText(`${text} ${SITE}`);
  } catch {
    /* nothing more we can do */
  }
}
