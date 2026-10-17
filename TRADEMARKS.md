# Trademark policy

The unAlgorithm source code and artwork are free software under the AGPL-3.0-only. As permitted by section 7(e) of
that license, **no rights are granted under trademark law to the names "unAlgorithm Feed", "unAlgorithm" and "unAlgo"
or the unAlgorithm logo**, which are trademarks of HeitechSoft. You may copy and modify the code and artwork, but you
may not use the names or logo to brand your own build or service.

## You may

- Say that your project is "based on unAlgorithm" or "a fork of unAlgorithm".
- Use the name to refer to this project accurately, for example in articles, reviews and talks.
- Build, run and modify the code for yourself or your organization.
- Run the unmodified unAlgorithm server (`apps/server`) for yourself or your organization, under a name of your own
  (`INSTANCE_NAME`). Don't call your server "unAlgorithm Cloud": that name is only HeitechSoft's hosted service at
  cloud.unalgorithm.app.

## Please don't, without written permission

- Publish a fork, a browser extension, an app or a service **named "unAlgorithm Feed", "unAlgorithm" or "unAlgo"**,
  or a confusingly similar name.
- Use the unAlgorithm logo or icon for your own build, extension listing or product.
- Suggest that HeitechSoft endorses or supports your fork or service.

If you publish a fork, rebrand everywhere the name and logo appear:

- `apps/extension/public/_locales/*/messages.json` (name and description) and `short_name` / `default_title` in
  `apps/extension/wxt.config.ts`;
- the icons in `apps/extension/public/icon` and `apps/extension/public/paused`, and `scripts/make-icons.mjs`;
- the `Logo`, `Wordmark` and `Lockup` components in `packages/ui/src/components/brand.tsx`;
- UI text and page titles: search the source for "unAlgorithm".

Questions or permission requests: **legal@heitechsoft.com**.

*LinkedIn and Facebook are trademarks of their respective owners. unAlgorithm Feed is not affiliated with LinkedIn or
Meta.*
