\# Morse Training Platform — Project Status



\## Project



LAN-only Morse/radiogram training platform for a military classroom.



The teacher's Windows PC is the only machine running the application/server.



Students connect using Chrome/Edge over the local LAN.



No student PC should require Node.js, npm, SQLite or application installation.



Example:

`http://TEACHER-PC-IP:PORT`



\## Architecture



\* Self-hosted

\* LAN-only

\* Offline at runtime

\* Node.js backend

\* React frontend

\* SQLite database

\* WebSockets for realtime communication

\* Modular monolith

\* Teacher PC = server + teacher workstation

\* \~20 simultaneous student clients



No:



\* CDN

\* Google Fonts

\* external APIs

\* cloud database

\* analytics

\* telemetry

\* internet dependency



\## Core functionality



The application is designed around:



Teacher configures/generates Morse radiogram

→ server distributes/manages session

→ students hear Morse

→ students type answer

→ server scores answer

→ result is stored

→ teacher can view results



The system supports:



\* individual practice

\* group training

\* formal testing



\## Roles



\### Teacher



\* manage students

\* manage classes

\* configure Morse sessions

\* start/pause/resume/stop group sessions

\* monitor students

\* view results/statistics

\* configure grading



\### Student



\* login

\* participate in training/tests

\* hear Morse

\* submit answers

\* view own results/history



Students must not be able to modify official session/test state, scores, configuration or other students' data.



\## Morse functionality



Configuration includes:



\* WPM

\* Farnsworth spacing

\* tone frequency

\* difficulty

\* character set

\* letters/numbers/punctuation

\* radiogram length

\* spacing/timing



Supports generated and manually entered radiograms.



Morse audio should be prepared/preloaded before synchronized playback where necessary.



\## Synchronization architecture



The server is authoritative.



Do NOT use:

"teacher clicks Start → browser immediately plays."



Instead:



1\. Server validates Start.

2\. Server chooses a future timestamp.

3\. Server broadcasts authoritative state + scheduled start.

4\. Clients synchronize/estimate clock offset.

5\. Clients preload required data/audio/timing.

6\. Clients schedule playback for the future server timestamp.

7\. Server remains authoritative.

8\. Reconnecting clients resynchronize from server state.



\## Development history



The project originally had many small development phases.



The current development point is approximately:



\*\*PHASE 8 — GROUP SESSIONS\*\*



Previous phases were intended to establish:



\* project foundation

\* authentication/accounts

\* Morse engine

\* individual practice

\* persistence/grading

\* teacher dashboard

\* realtime WebSocket layer



These previous features should NOT be rebuilt unless inspection shows that they are missing or broken.



\## Current task



Continue with:



\*\*PHASE 8 — Group Sessions \& Server-Authoritative Synchronization\*\*



Required functionality:



\* group session creation

\* teacher controls

\* explicit server-side session state

\* scheduled synchronized start

\* client/server clock offset

\* Morse/audio preloading

\* WebSocket state broadcasts

\* student session UI

\* teacher live monitoring

\* reconnect/resync

\* refresh recovery

\* authorization/security

\* approximately 20 simultaneous clients

\* automated/integration testing



\## Important development rules



Before coding:



1\. Inspect the existing project.

2\. Read README.md.

3\. Read PROJECT\_STATUS.md.

4\. Inspect database/schema.

5\. Inspect backend.

6\. Inspect frontend.

7\. Inspect WebSocket implementation.

8\. Inspect Morse/audio implementation.

9\. Inspect tests.

10\. Determine what Phase 8 is already implementing.



Do NOT:



\* rebuild the project

\* rewrite working functionality

\* create duplicate systems

\* replace the architecture unnecessarily

\* introduce microservices

\* introduce internet dependencies

\* use fake/mock production functionality



Reuse the existing implementation.



After Phase 8:



\* update this file

\* document what was actually implemented

\* document tests performed

\* document known limitations

\* STOP and wait for the next phase



Do not automatically proceed to Phase 9.



\## Next roadmap



After Phase 8, development continues in larger milestones:



Phase 9 — Formal Testing System



Phase 10 — Complete Teacher \& Student Experience



Phase 11 — Reliability, Security, Statistics \& Backup



Phase 12 — Windows Deployment \& Final LAN QA



