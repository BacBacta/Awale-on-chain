// Web Push registration (scaffold). Call `registerPush(address)` from an opt-in
// UI (it prompts for notification permission) once VAPID is configured:
//   NEXT_PUBLIC_VAPID_PUBLIC_KEY (app) + VAPID_PUBLIC_KEY/PRIVATE_KEY (server).
// No-ops gracefully where unsupported (e.g. some webviews) or unconfigured.

import type { Address } from "viem";

const SERVER_URL = process.env.NEXT_PUBLIC_SERVER_URL ?? "";
const VAPID_PUBLIC = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? "";

export function pushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window &&
    !!SERVER_URL &&
    !!VAPID_PUBLIC
  );
}

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** Returns true if a push subscription was registered with the server. */
export async function registerPush(address: Address): Promise<boolean> {
  if (!pushSupported()) return false;
  try {
    const reg = await navigator.serviceWorker.register("/sw.js");
    const permission = await Notification.requestPermission();
    if (permission !== "granted") return false;

    const existing = await reg.pushManager.getSubscription();
    const sub =
      existing ??
      (await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC) as BufferSource,
      }));

    const res = await fetch(`${SERVER_URL}/push/subscribe`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address, subscription: sub.toJSON() }),
    });
    return res.ok;
  } catch {
    return false;
  }
}
