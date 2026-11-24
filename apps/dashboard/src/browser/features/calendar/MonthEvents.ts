import type { CalendarEvent } from "@homelab/contracts/miraCalendar";
import { createContext } from "react";
export const MonthEvents = createContext<readonly CalendarEvent[]>([]);
