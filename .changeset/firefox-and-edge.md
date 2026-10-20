---
'@unalgorithm/extension': minor
---

unAlgorithm Feed now runs in Microsoft Edge and in Firefox 147 or newer, with everything the Chrome build has. In
Firefox, Highlights opens in the sidebar (Open Highlights in the popup, or Alt+Shift+U), Firefox asks for your consent
before post text, your settings or your account details go to any service, even one on your computer, and there is no
on-device AI; in Edge, on-device AI is Edge's own preview. In builds with the unAlgorithm server card, signing in works
in all three browsers, and each device is named for its browser, such as "Firefox on Linux" (in Firefox, while its
technical and interaction data choice, offered at install, is on). Report a problem names your browser and its major
version, and the Ollama tip covers Firefox: `OLLAMA_ORIGINS=chrome-extension://*,moz-extension://*`. Each release now
carries the Edge and Firefox zips, the Firefox sources, a sideload zip for Chrome and Edge and, when Firefox Add-ons
signs it, a Firefox file to install from the release.
