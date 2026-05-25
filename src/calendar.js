// ============================================
// calendar.js — Jain tithi calendar integration
// Fetches events from public Google Calendar
// ============================================

const JAIN_CALENDAR_URL = 'https://calendar.google.com/calendar/ical/yja.org_s2t29hla94rej0pieuc8t17a34%40group.calendar.google.com/public/basic.ics';

// Returns parsed events from KV cache if available, otherwise fetches live.
// Caches raw events (not formatted) so the TODAY label stays accurate on each request.
export async function getCalendarCached(env) {
  try {
    const cached = await env.KV.get('jain_calendar_events');
    if (cached) {
      const events = JSON.parse(cached);
      return events.map(e => ({ ...e, date: new Date(e.date) }));
    }
  } catch (err) {
    console.log('KV read error:', err.message);
  }
  // Cache miss — fetch live and store
  const events = await getTodayAndUpcomingEvents();
  try {
    await env.KV.put('jain_calendar_events', JSON.stringify(events), { expirationTtl: 86400 });
  } catch (err) {
    console.log('KV write error:', err.message);
  }
  return events;
}

const CALENDAR_TZ = 'America/New_York';

// Returns a Date pinned to midnight in the given IANA timezone,
// expressed as a UTC instant we can compare against parseICSDate output
// (which also returns local-midnight Date objects).
function todayInTimezone(tz) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date());
  const y = parseInt(parts.find(p => p.type === 'year').value);
  const m = parseInt(parts.find(p => p.type === 'month').value) - 1;
  const d = parseInt(parts.find(p => p.type === 'day').value);
  // Use local-midnight Date — matches parseICSDate's construction
  return new Date(y, m, d);
}

export async function getTodayAndUpcomingEvents() {
  try {
    const res = await fetch(JAIN_CALENDAR_URL);
    const icsText = await res.text();

    const today = todayInTimezone(CALENDAR_TZ);

    const upcoming = new Date(today);
    upcoming.setDate(upcoming.getDate() + 30);

    const events = parseICS(icsText);

    const relevantEvents = events.filter(event => {
      return event.date >= today && event.date <= upcoming;
    });

    relevantEvents.sort((a, b) => a.date - b.date);

    return relevantEvents.slice(0, 10);

  } catch (err) {
    console.log('Calendar fetch error:', err.message);
    return [];
  }
}

function parseICS(icsText) {
  const events = [];
  const lines = icsText.split('\n').map(l => l.trim());
  
  let currentEvent = null;
  
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') {
      currentEvent = {};
    } else if (line === 'END:VEVENT' && currentEvent) {
      if (currentEvent.date && currentEvent.summary) {
        events.push(currentEvent);
      }
      currentEvent = null;
    } else if (currentEvent) {
      if (line.startsWith('SUMMARY:')) {
        currentEvent.summary = line.replace('SUMMARY:', '').trim();
      } else if (line.startsWith('DTSTART')) {
        const dateStr = line.split(':')[1]?.trim();
        if (dateStr) {
          currentEvent.date = parseICSDate(dateStr);
        }
      } else if (line.startsWith('DESCRIPTION:')) {
        currentEvent.description = line.replace('DESCRIPTION:', '').trim();
      }
    }
  }
  
  return events.filter(e => e.date);
}

function parseICSDate(dateStr) {
  try {
    // Handle YYYYMMDD format
    if (dateStr.length === 8) {
      const year = parseInt(dateStr.substring(0, 4));
      const month = parseInt(dateStr.substring(4, 6)) - 1;
      const day = parseInt(dateStr.substring(6, 8));
      return new Date(year, month, day);
    }
    // Handle YYYYMMDDTHHMMSSZ format
    if (dateStr.includes('T')) {
      const year = parseInt(dateStr.substring(0, 4));
      const month = parseInt(dateStr.substring(4, 6)) - 1;
      const day = parseInt(dateStr.substring(6, 8));
      return new Date(year, month, day);
    }
    return null;
  } catch {
    return null;
  }
}

export function formatEventsForClaude(events, userTimezone, limit = 3) {
  const tz = userTimezone || CALENDAR_TZ;

  if (!events || events.length === 0) {
    return `TODAY_IS_TITHI: false
UPCOMING (informational only, NOT today): none`;
  }

  const today = todayInTimezone(tz);
  const todayStr = today.toDateString();

  // Find today's event (if any) and upcoming events (excluding today)
  const todayEvent = events.find(e => e.date.toDateString() === todayStr);
  const upcoming = events
    .filter(e => e.date.toDateString() !== todayStr)
    .slice(0, limit);

  // Today line — explicit boolean so Claude can't misread
  const todayLine = todayEvent
    ? `TODAY_IS_TITHI: true
TODAY_TITHI_NAME: ${todayEvent.summary}`
    : `TODAY_IS_TITHI: false`;

  // Upcoming line — labeled so Claude can't mistake a future event for today
  const upcomingLines = upcoming.length
    ? upcoming.map(event => {
        const label = event.date.toLocaleDateString('en-US', {
          weekday: 'short', month: 'short', day: 'numeric', timeZone: tz
        });
        return `${label}: ${event.summary}`;
      }).join('\n')
    : 'none';

  return `${todayLine}
UPCOMING (informational only, NOT today):
${upcomingLines}`;
}
