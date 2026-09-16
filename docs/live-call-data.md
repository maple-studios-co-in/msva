# Live call data for the demo

The main site opens on **Live call data**. It reads recorded phone and browser
sessions from the call database and refreshes every five seconds. The separate
**Sample analytics** screen still contains the illustrative spreadsheet; those
figures never contribute to the live table or its totals.

## Running a demo

1. Open the main site and choose **Start demo session** to show calls starting
   from that point. This filters the view; it does not delete any records.
2. Make an Exotel phone call or use **Browser call** with the browser microphone.
3. The new row shows time in India time, masked caller number, channel, status,
   duration, turns, linked saved tickets and recorded fallback/recognition retries.
4. The row updates as turns are saved, then shows the final status and duration.
   Use **Today** to return to all of today's recorded sessions.

The session start is saved in this browser. Channel filters let you show phone
calls, browser calls or both. Test badges describe the session's test flag;
browser microphone sessions are actual recorded sessions even though they are
marked as tests. Automated verification records are excluded.

## What the figures mean

- Recorded calls count persisted call sessions within the selected period and
  channel, across every page of results.
- Completed calls means the session ended, not that the caller's issue was resolved.
- Ticket counts come from saved ticket rows linked to those calls.
- Error counters count recorded fallback replies and recognition retries.
- An absent value stays absent. Browser caller identity is not verified and is
  shown as **Not provided**. The public view does not expose caller names, full
  telephone numbers, transcripts, collected information or provider IDs.

The signed-in support console contains detailed transcripts. Its call list also
shows channel and call status. A completed call with no confirmed action is
labelled **No confirmed resolution**, not resolved because it had several turns.
Historical outcomes from before this update are retained; the new public view
does not use them as resolution statistics.

## Implementation and checks

`GET /api/live-calls` uses India-time midnight by default and supports an ISO
`from` timestamp, `channel=all|phone|browser`, `page`, and `pageSize` (maximum 50).
The page and aggregate totals share a database snapshot. Database failures return
503 rather than an empty table or sample data. Responses are not cached.

Regression checks cover data masking, filtering, full-result totals, empty/error
states, call-log ordering, browser profile initialization and factual outcomes.
No database migration is required.
