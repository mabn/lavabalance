Spring Lobby Protocol — the canonical reference (this is the protocol BAR's Teiserver speaks):

- Rendered: https://springrts.com/dl/LobbyProtocol/ProtocolDescription.html
- Index/landing: http://springrts.com/dl/LobbyProtocol/
- Source XML (most precise, what I quote below): https://github.com/spring/LobbyProtocol/blob/master/ProtocolDescription.xml

What BAR actually runs — Teiserver's own implementation is the ground truth when the spec and reality differ:

- Server→client commands (incl. CLIENTBATTLESTATUS): lib/teiserver/protocols/spring/spring_out.ex
- Client→server commands (incl. MYBATTLESTATUS): lib/teiserver/protocols/spring/spring_in.ex
- Repo: https://github.com/beyond-all-reason/teiserver

In this project: our decoder is src/protocol/battleStatus.ts and the parser is parseClientBattleStatus in src/protocol/events.ts.