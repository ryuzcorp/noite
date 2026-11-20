### Fixed

- Live views stay live: the app page's status badge, logs, events and every other streamed feed kept their connection open but stopped receiving updates about 30 seconds after the page loaded, so a Stop or Start only showed after a reload. Cello 0.2.3 no longer charges a streamed response to the post-response background budget. A stream that makes no progress for 60 seconds now ends instead of hanging; Noite's feeds send a keepalive every 15 seconds.
