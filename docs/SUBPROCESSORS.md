# Services a Cardlake uses

A Cardlake runs in its owner's own accounts; the people who make Cardlake
receive nothing. Review this list when a feature starts sending data to a new
service, and keep `public/privacy.html` ("Other services involved") in step.

| Service | Role | Data | When |
|---|---|---|---|
| Vercel | Hosting, serverless functions, private file storage (Blob) | Requests, application logs, attached files | Always |
| Neon | Postgres database | Cards, the owner's account, activity history, encrypted integration tokens | Always |
| GitHub | Issues integration | The owner's fine-grained token, used to read one repository's issues | Only if connected |
| The owner's AI assistant (e.g. Anthropic, OpenAI) | MCP client | The tool arguments and results needed to answer the owner | Only if connected |
| Sites cards link to | Media previews | The browser's IP address when a thumbnail loads | Only with previews on |
| Google Calendar | "Add to Google Calendar" | The reminder copied into a new event, by the owner's own browser | Only when the owner clicks it |

There are no analytics, advertising or sign-in providers.
