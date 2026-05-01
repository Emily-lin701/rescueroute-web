# 🚒 RescueRoute Web

A playable browser-based traffic-control game built with **TypeScript + Phaser 3 + Vite**.  
Guide a fire truck through controlled intersections before the building burns down!

🎮 **Play it live:** <https://Emily-lin701.github.io/rescueroute-web/>

---

## Controls

| Key | Action |
|-----|--------|
| `1` | Toggle M2 signal (NS ↔ EW green) |
| `2` | Toggle M3 signal (NS ↔ EW green) |
| `G` | Activate GreenWave (costs 3 cmd points) |
| `Enter` | Dispatch fire truck (after fire spawns) |

---

## Gameplay

1. **Wait** — at **t = 3 s** a fire spawns at either **S2** or **S3**.
2. **Manage signals** — press `1` / `2` to set the right phase at M2/M3 before dispatching.
3. **Press Enter** to dispatch the truck from M1 along its route.
4. The truck stops at the **stop-line (92 % of segment)** if the intersection signal is red.  
   Toggle the correct phase to let it through.
5. **Deadline at 30 s** — after that the fire value grows 15 / s.  
   Reach 100 → **BURNED** (−300 pts). Get the truck there first → **SAVED** (+500 pts).

### Truck routes
| Target | Path |
|--------|------|
| S2 | M1 → R12 → M2 **(NS green)** → R2S → S2 |
| S3 | M1 → R12 → M2 (EW green) → R23 → M3 **(NS green)** → R3S → S3 |

### Scoring
- Starts at **1000**
- −2 pts / second
- **+500** on rescue
- **−300** on burned

### GreenWave
Press `G` (costs 3 cmd points) to boost truck speed ×1.2 on mainline roads (R12/R23/R34) for **6 seconds**.  
Command points regenerate at 0.8 / s (max 10).

---

## Local Development

```bash
npm install
npm run dev      # http://localhost:5173/rescueroute-web/
npm run build    # production build → dist/
npm run preview  # preview the built app
```

Requires **Node 18+**.

---

## Deployment

Pushes to `main` automatically trigger the GitHub Actions workflow (`.github/workflows/deploy.yml`),  
which builds the project and deploys `dist/` to GitHub Pages.

Enable Pages in **Settings → Pages → Source: GitHub Actions**.
