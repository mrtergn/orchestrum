"use client";

import { useEffect, useState } from "react";

type Notice = { id: string; message: string; tone: "warning" | "info" | "danger" };

export function Notifications() {
  const [notices, setNotices] = useState<Notice[]>([]);

  useEffect(() => {
    const load = async () => {
      const list: Notice[] = [];
      const updateRes = await fetch("/api/updates/status", { cache: "no-store" });
      if (updateRes.ok) {
        const data = await updateRes.json();
        if (data.updateAvailable) {
          list.push({
            id: "update",
            message: `Update available: ${data.available?.version ?? "new version"} (${data.available?.channel ?? "stable"})`,
            tone: "info"
          });
        }
      }
      const policyFlag = localStorage.getItem("orchestrum.notice.policy") === "1";
      if (policyFlag) {
        list.push({
          id: "policy",
          message: "Policy violation detected in the last run.",
          tone: "danger"
        });
      }
      setNotices(list);
    };
    load();
  }, []);

  if (notices.length === 0) return null;

  return (
    <div className="space-y-2">
      {notices.map((notice) => (
        <div
          key={notice.id}
          className={`rounded-xl border px-4 py-2 text-xs ${
            notice.tone === "danger"
              ? "border-rose-400/50 bg-rose-400/10 text-rose-200"
              : notice.tone === "warning"
                ? "border-amber-400/50 bg-amber-400/10 text-amber-200"
                : "border-sky-400/50 bg-sky-400/10 text-sky-200"
          }`}
        >
          {notice.message}
        </div>
      ))}
    </div>
  );
}
