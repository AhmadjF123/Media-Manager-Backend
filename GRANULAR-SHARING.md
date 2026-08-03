# Granular sharing

Each friendship now has an explicit access scope:

- `all`: every saved title, including future additions.
- `selected`: only the title tokens in `selected_items`.
- `all_except`: every title except the tokens in `selected_items`.
- `filters`: automatic Watching, Watched and Favourite categories.
- `none`: no visible titles while the friendship remains active.

The owner can save global defaults, apply them to all current friends, or copy one exact permission set to several chosen friends. Ratings remain independently controllable and personal notes are never returned by the shared-vault API.
