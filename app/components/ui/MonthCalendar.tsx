'use client';

import { useState, useEffect } from 'react';
import { ChevronLeft, ChevronRight, Calendar } from 'lucide-react';

export interface MonthCalendarProps {
  className?: string;
  /** Days that have pending activity (shown with an underline), e.g. [20] for Nov 20th. */
  pendingDates?: number[];
}

/** Design-only month calendar (no database). Renders a monthly grid and highlights today. */
export function MonthCalendar({ className, pendingDates = [] }: MonthCalendarProps) {
  const [view, setView] = useState<Date>(new Date());

  useEffect(() => {
    setView(new Date());
  }, []);

  const year = view.getFullYear();
  const month = view.getMonth();
  const today = new Date();
  const isToday = (d: Date) =>
    d.getDate() === today.getDate() &&
    d.getMonth() === today.getMonth() &&
    d.getFullYear() === today.getFullYear();
  const hasActivity = (d: number) => pendingDates.includes(d);

  const firstDay = new Date(year, month, 1);
  const lastDay = new Date(year, month + 1, 0);
  const startOffset = (firstDay.getDay() + 6) % 7; // Monday = 0
  const totalDays = lastDay.getDate();
  const prevMonthLast = new Date(year, month, 0).getDate();

  const days: Array<{ num: number; month: number; today: boolean; disabled: boolean; activity: boolean }> = [];
  for (let i = 0; i < startOffset; i++) {
    days.push({ num: prevMonthLast - startOffset + i + 1, month: month - 1, today: false, disabled: true, activity: false });
  }
  for (let d = 1; d <= totalDays; d++) {
    days.push({ num: d, month, today: isToday(new Date(year, month, d)), disabled: false, activity: hasActivity(d) });
  }
  while (days.length % 7 !== 0) {
    days.push({ num: days.length - totalDays - startOffset + 1, month: month + 1, today: false, disabled: true, activity: false });
  }

  const monthNames = [
    'Tháng 1', 'Tháng 2', 'Tháng 3', 'Tháng 4', 'Tháng 5', 'Tháng 6',
    'Tháng 7', 'Tháng 8', 'Tháng 9', 'Tháng 10', 'Tháng 11', 'Tháng 12',
  ];
  const weekdays = ['T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'CN'];

  return (
    <section className={`month-calendar-card ${className ?? ''}`}>
      <div className="month-calendar-head">
        <button
          type="button"
          className="month-calendar-nav"
          onClick={() => setView(d => new Date(d.getFullYear(), d.getMonth() - 1))}
          aria-label="Tháng trước"
        >
          <ChevronLeft size={13} />
        </button>
        <div className="month-calendar-title">
          <Calendar size={13} style={{ marginRight: 5, opacity: 0.8 }} />
          <span>{monthNames[month]} {year}</span>
        </div>
        <button
          type="button"
          className="month-calendar-nav"
          onClick={() => setView(d => new Date(d.getFullYear(), d.getMonth() + 1))}
          aria-label="Tháng sau"
        >
          <ChevronRight size={13} />
        </button>
      </div>
      <div className="month-calendar-grid">
        {weekdays.map(wd => (
          <div key={wd} className="month-calendar-weekday">{wd}</div>
        ))}
        {days.map((d, i) => (
          <div
            key={i}
            className={`month-calendar-day ${d.disabled ? 'disabled' : ''} ${d.today ? 'today' : ''} ${d.activity ? 'activity' : ''}`}
          >
            <span className="month-calendar-day-num">{d.num}</span>
          </div>
        ))}
      </div>
      <div className="month-calendar-today">
        <span className="month-calendar-today-dot" />
        <span className="month-calendar-today-label">Hôm nay: {today.getDate()}/{today.getMonth() + 1}/{today.getFullYear()}</span>
      </div>
    </section>
  );
}
