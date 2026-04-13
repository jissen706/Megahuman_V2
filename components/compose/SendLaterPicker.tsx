"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface Props {
  onSelect: (date: Date) => void;
  onCancel: () => void;
}

function nextWeekday(day: number, hour = 9): Date {
  const d = new Date();
  d.setHours(hour, 0, 0, 0);
  const diff = (day - d.getDay() + 7) % 7 || 7;
  d.setDate(d.getDate() + diff);
  return d;
}

function tomorrowAt(hour = 9): Date {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(hour, 0, 0, 0);
  return d;
}

function inHours(n: number): Date {
  return new Date(Date.now() + n * 60 * 60 * 1000);
}

const QUICK_OPTIONS: { label: string; date: () => Date }[] = [
  { label: "In 1 hour",         date: () => inHours(1) },
  { label: "Tomorrow morning",  date: () => tomorrowAt(9) },
  { label: "Monday morning",    date: () => nextWeekday(1, 9) },
];

/**
 * Send later date/time picker.
 * Offers quick presets + custom datetime input.
 */
export default function SendLaterPicker({ onSelect, onCancel }: Props) {
  const [customDate, setCustomDate] = useState("");

  return (
    <div className="rounded-lg border border-zinc-100 bg-white p-4 shadow-sm">
      <p className="mb-3 text-xs font-medium text-zinc-500">Send later</p>

      <div className="mb-3 flex flex-col gap-1.5">
        {QUICK_OPTIONS.map((opt) => (
          <button
            key={opt.label}
            onClick={() => onSelect(opt.date())}
            className="rounded px-2 py-1.5 text-left text-sm text-zinc-700 hover:bg-zinc-50"
          >
            {opt.label}
          </button>
        ))}
      </div>

      <div className="flex flex-col gap-1.5">
        <Label className="text-xs text-zinc-400">Custom date & time</Label>
        <Input
          type="datetime-local"
          value={customDate}
          onChange={(e) => setCustomDate(e.target.value)}
          className="text-sm"
        />
      </div>

      <div className="mt-3 flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          size="sm"
          disabled={!customDate}
          onClick={() => customDate && onSelect(new Date(customDate))}
        >
          Schedule
        </Button>
      </div>
    </div>
  );
}
