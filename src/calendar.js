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

export async function getTodayAndUpcomingEvents() {
  try {
    const res = await fetch(JAIN_CALENDAR_URL);
    const icsText = await res.text();
    
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
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

export function formatEventsForClaude(events) {
  if (!events || events.length === 0) {
    return 'No upcoming Jain calendar events found in the next 30 days.';
  }
  
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  
  const lines = events.map(event => {
    const isToday = event.date.toDateString() === today.toDateString();
    const dateLabel = isToday 
      ? 'TODAY' 
      : event.date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    return `${dateLabel}: ${event.summary}`;
  });
  
  return lines.join('\n');
}
