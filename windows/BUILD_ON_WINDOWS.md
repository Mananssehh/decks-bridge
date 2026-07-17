# Build note (for you, not testers)

The Windows `.exe` files are built on a **Windows PC**, not on Mac.

On a Windows 10/11 machine, from the project folder run:

```powershell
npm ci
npm run build:internal:windows
```

That fills this folder with:

- `Decks Bridge Setup.exe`
- `Decks Bridge Portable.exe`
- `Decks Bridge.zip`

Then zip **`decks bridge windows`** and send it to Windows testers.
