# Payload Toolkit

Payload Toolkit is a collection of plugins for Payload CMS. Its shared workspace provides the foundation for developing and releasing those plugins.

## Language

**Workspace skeleton**:
The operational repository foundation: root configuration and tracked `apps/` and `packages/` containers, without a runnable application or publishable package.
_Avoid_: Empty monorepo, starter app

**Validation baseline**:
The root-level gates for formatting and linting, type-checking, unit tests, integration tests, and end-to-end tests that every future workspace project participates in.
_Avoid_: Tooling setup, code validation

**Payload plugin**:
A focused extension for Payload CMS that Payload Toolkit develops for independent release.
_Avoid_: Add-on, workspace package

**Workspace application**:
A non-published Payload CMS application used to demonstrate plugins or exercise them through integration and end-to-end tests.
_Avoid_: Payload plugin, production app

**Internal library**:
A non-published workspace package introduced only when multiple Payload plugins need to share an implementation.
_Avoid_: Payload plugin, configuration package

**BlurHash plugin**:
The Payload plugin that enriches eligible images with a compact placeholder representation and exposes a static preview in Payload Admin.
_Avoid_: Image optimizer, thumbnail generator, logger package

**Eligible image**:
A newly uploaded or replaced static raster asset in a configured media collection that the BlurHash plugin supports.
_Avoid_: Media file, all uploads, existing media
