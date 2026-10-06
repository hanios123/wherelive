# Security policy

## Supported versions

Only the latest published version of `wherelive` gets security fixes.

## Reporting a vulnerability

Please do not open a public issue for a security problem.

Report it privately through GitHub: go to the **Security** tab of this repository and choose **Report a vulnerability** ([direct link](https://github.com/hanios123/wherelive/security/advisories/new)).

Include what you found, the version, and the smallest steps or query that shows it. You will get a reply within a few days. A fix and a release come first, and then the advisory is published with credit to you if you want it.

## Scope

wherelive is a client-side query library. It does not store data, hold credentials or open its own network connections: reads and listens go through the Firebase SDK that your app passes in. Reports about how your Firebase security rules are written belong with Firebase, not here. Things that are in scope include wrong results that could expose rows a query was meant to exclude, and unsafe handling of paths or ids (see `sanitizeId`).
