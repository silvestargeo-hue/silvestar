"use client";

/** Notification center — platform notices + personal reminders. */
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Modal, toast } from "@/lib/kit";

export function useNotificationCount(userId: string) {
  const [count, setCount] = useState(0);
  const refresh = useCallback(async () => {
    try {
      const r = await api.notifications(userId);
      setCount(r.notifications.length);
    } catch { /* offline ok */ }
  }, [userId]);
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 30000);
    return () => clearInterval(t);
  }, [refresh]);
  return { count, refresh };
}

export function NotificationCenter({ userId, open, onClose, onChanged }: {
  userId: string; open: boolean; onClose: () => void; onChanged?: (n: number) => void;
}) {
  const [items, setItems] = useState<{ id: string; message: string; ts: string }[]>([]);
  const [reminder, setReminder] = useState("");

  const load = useCallback(async () => {
    try {
      const r = await api.notifications(userId);
      setItems(r.notifications);
      onChanged?.(r.notifications.length);
    } catch { /* offline ok */ }
  }, [userId, onChanged]);

  useEffect(() => { if (open) load(); }, [open, load]);

  const dismiss = async (id: string) => {
    try {
      await api.dismissNotification(id, userId);
      await load();
    } catch (e) { toast(String(e), "err"); }
  };

  const remind = async () => {
    if (!reminder.trim()) return;
    try {
      await api.addNotification(userId, reminder.trim());
      setReminder("");
      toast("Reminder queued ✓", "ok");
      await load();
    } catch (e) { toast(String(e), "err"); }
  };

  return (
    <Modal title="🔔 Notifications" onClose={onClose}>
      <div className="row" style={{ marginBottom: 12 }}>
        <input
          value={reminder}
          placeholder="Set a personal reminder…"
          onChange={(e) => setReminder(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && remind()}
        />
        <button onClick={remind}>Remind me</button>
      </div>
      {items.length === 0 && <div className="hint">No notifications — you're all caught up.</div>}
      {items.map((n) => (
        <div key={n.id} className="hit">
          <div className="t">
            🔔 {n.message}
            <button className="mini ghost" style={{ marginLeft: "auto" }} onClick={() => dismiss(n.id)}>✓</button>
          </div>
          <div className="s">{n.ts}</div>
        </div>
      ))}
    </Modal>
  );
}
