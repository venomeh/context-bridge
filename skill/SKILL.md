---
name: bubble-agent
description: Read and change a Bubble.io app safely — find elements, look up how a property must be stored, propose a change, preview it, apply it, and verify it against the running app. Use whenever the task involves editing a Bubble app through the bubble_* MCP tools.
---

# Working on a Bubble app

Bubble will tell you a write succeeded when it did nothing at all. Almost every rule
below exists because of that one fact.

## The loop

1. `bubble_status` if anything looks wrong. It reports whether the running app is
   reachable, which is what verification depends on.
2. `bubble_find` to locate what you are changing, and `bubble_read` to see what is
   there now. Never write to a path you have not read.
3. `bubble_property_key` for every property you are not certain about.
4. `bubble_plan_change` → `bubble_preview_change` → `bubble_apply_change`.
5. If the result is wrong, `bubble_revert_change`.

Do not skip to apply. The preview is where a mistake costs nothing.

## The trap everything else follows from

Bubble stores some properties under short codes (`%3` for text, `%ps` for placeholder)
and others under their long name (`padding_left`, `order`, `src`). Nothing about a
property's name tells you which it is, and **the two are not interchangeable**: write
`text` where `%3` belongs and Bubble returns HTTP 200, stores a key the app never reads,
and the export renders it under the same name as the real property — so it looks correct
everywhere except in the running app.

`bubble_property_key` answers this per app, from that app's own Bubble build. Use it.
`bubble_plan_change` refuses the mistake, but knowing why saves you a round trip.

## Verification means the running app

The export is the right tool for addressing — ids, paths, structure — and the wrong tool
for confirming a change. It is a rendered view that translates codes into long names, so
it cannot show you a dead key. `bubble_apply_change` verifies against the running app
automatically. If `bubble_status` says the running app is unreachable, say so before
writing, because every write after that is unconfirmed.

## Value shapes differ by element type

A Text's `text` is an expression: `{"%e":{"0":"hello"},"%x":"TextExpression"}`.
A Link's `text` is a **plain string**. An expression there renders empty.

`bubble_element_schema` tells you which properties a type accepts. A Video takes
`video_source` and `video_id`, never a bare URL. Check before inventing a property.

## Creating elements

An element node is:

```json
{ "%p": {...properties}, "%x": "Text", "id": "...", "%dn": "Text A", "%nm": "my text",
  "%s1": "Text_body_16_", "%el": {...children} }
```

- `bubble_mint_ids` for ids that cannot collide with ids Bubble will issue later.
- Attach `%s1`, the type's default style from `bubble_overview`, and the element
  inherits the app's real design tokens. Do not invent colours and sizes.
- Children nest under `%el`, keyed by object key. Parents before children.
- Bubble maintains its own id index; you never write it.

## Things that are silently true

- **A container between a repeating group's cell and the fields reading from it severs
  the binding**, unless that container carries `%ds = {"%x":"ElementParent"}` and the
  list's type of content. Rows come back blank with no error.
- **Sibling order is renormalised inside a subtree write.** `bubble_apply_change`
  reconciles it afterwards; do not assume order survived a bulk write.
- **A property owned by a named style is inert when set inline.** The write succeeds and
  nothing changes. Change the style, or accept the override knowingly.
- **`container_layout` cannot be changed in a conditional state.** Rows stack because
  Bubble computes `flex-wrap` from the children's `min_width_css`; children at `0px`
  never wrap.
- **Percentage widths only align if the containers are provably the same width.**
  Matching percentages on two rows is not enough.
- **Writing `null` deletes.** There is no separate delete call.

## Refusals you will meet, and what they mean

| refusal | meaning |
|---|---|
| `long-name-for-coded-property` | use the `%code` the message gives you |
| `unknown-code` | that code does not exist in this app's Bubble build |
| `escape-damage` | a string carries a literal `\n`; it came from a bundle decoded one level short |
| `missing-parent` | the parent path does not exist, so this would create an orphan |
| `editor-open` | someone is editing the app; their autosave would overwrite this |
| `unsafe-revert` | the previous value was not captured, so reverting would delete rather than restore |

None of these are advisory. Fix the cause rather than looking for a way past them.

## When you are unsure

Read more of the app first. `bubble_find` with no element name lists a whole page;
`bubble_read` on a working element of the same type shows you exactly how Bubble stores
that thing in this app. Copying the shape of something that already works beats
reasoning about what the shape ought to be.
