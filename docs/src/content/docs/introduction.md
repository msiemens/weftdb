---
title: Introduction
description: What weftdb is, how it keeps a person's devices in step, and what it does not do.
sidebar:
  order: 1
---

weftdb is a TypeScript library for building applications that keep their data on the user's own
device. You describe your tables once, and it generates the local database, the row types, the
write helpers, and the code that keeps one person's devices in step with each other.

Reads and writes go to a database on the device, so the interface never waits for a server and an
edit is saved before any request is sent. When a connection is available, devices exchange changes
through a small server you run yourself. A device that has been offline for a month catches up
when it comes back.

## How it works

**On the device** there is a SQLite database with ordinary typed tables, generated from a schema
you write in TypeScript. Every read the interface makes goes to this database, and every write
lands here first and stays here.

**On the server** there is one generic table holding a value per record and field. This server is
called the relay. It has none of your tables and never learns your schema, so adding a field to
your application is something you deploy to the client. The relay needs no migration and no
redeploy.

**Between them**, a device sends what it changed and receives what other devices changed. Changes
are merged one field at a time, so two devices that edit different fields of the same record each
keep their edit. When both edit the same field, the later edit wins, and which one is later is
decided by a clock reading that every device compares the same way.

Deleting is recorded rather than implied. A removed record leaves a marker behind, because a
record that is simply missing cannot tell a device whether it was deleted or never existed.

## What you get

| Capability        | What it means                                                                                             |
| ----------------- | --------------------------------------------------------------------------------------------------------- |
| Offline writes    | Edits are stored on the device first, and survive reloads and long offline stretches                      |
| Sync              | A device sends its changes, receives others, and asks for a full copy if it has fallen too far behind     |
| Live updates      | Devices that are connected receive changes as they happen, and fall back to polling if they cannot        |
| Generated code    | One schema produces the SQL, the row types, the write helpers, the React hooks, and the query helpers     |
| React bindings    | Generated hooks return typed rows and re-render a component when its data changes                         |
| Visible conflicts | An edit that cannot be applied is set aside with a reason, so the application can ask rather than lose it |

## What it does not do

**One person, several devices.** There is no sharing and no collaboration. Access is decided by
whose data a record belongs to, and there is nothing finer than that: no per-record permissions
and no way to invite anyone.

**Self-hosted only.** You run the relay. There is no service to sign up for.

**No live co-editing of text.** A text field can be marked to merge three ways, the way a version
control system merges a file: two devices that edit it while apart are combined when they sync,
and overlapping edits to the same lines leave conflict markers for a person to resolve. There is
no character-level merge, so two people typing into one field at the same moment is not supported.
This is a limit on text fields alone. Edits to different fields of the same record all survive,
whatever the field holds.

**One relay process.** A connected device is tied to the process holding its connection, so
running several relays is not supported.

## Where to go next

Follow the [Quick start](/quick-start/) to run the demo, write a schema, and sync a first record.
Read [Architecture](/concepts/architecture/) for why the server holds a generic table rather than
a copy of yours, and what follows from that.
