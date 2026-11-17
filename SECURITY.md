# Security and privacy

OneWay's main promise is that a medical record never leaves the person's device. A way to make any part of a record
reach a network request, a log, a cache or a third party is a vulnerability, even a partial one.

## Reporting

Please report it privately through GitHub: **Security → Report a vulnerability** on this repository. Do not open a
public issue, and do not include anyone's real medical information in a report: a fictional record that reproduces
the problem is enough.

## What is in scope

- Record text, or anything derived from it, reaching a request that leaves the page (cloud model, registry,
  Firestore, Remote Config, or any other host).
- A way around the Content Security Policy in `firebase.json`.
- Writing misleading rules into the shared Firestore cache, or reading anything but public rules from it.
- The optional memory kept in the browser (IndexedDB) being readable by another site.

## What is not

- The registry search, which sends a condition name and a place the person sees and approves.
- Firebase's own background traffic (App Check, anonymous sign-in), which carries nothing from the record.
- Medical accuracy of a verdict. That is a quality issue: please open a normal issue, with a fictional example.
