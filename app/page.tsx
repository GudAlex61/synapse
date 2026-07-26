import { HomeForm } from "@/components/home-form"
import { Clapperboard } from "lucide-react"

export default function HomePage() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center px-4 py-10">
      <div className="w-full max-w-md">
        <div className="mb-8 flex flex-col items-center text-center">
          <span className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-primary text-primary-foreground">
            <Clapperboard className="h-7 w-7" />
          </span>
          <h1 className="text-balance text-3xl font-semibold tracking-tight text-foreground">
            Watch Together
          </h1>
          <p className="mt-2 text-pretty text-sm leading-relaxed text-muted-foreground">
            Sync a movie with your partner in real time — same playback, live chat, one private room.
          </p>
        </div>

        <HomeForm />

        <p className="mt-6 text-center text-xs leading-relaxed text-muted-foreground">
          Works on any phone or laptop browser. Load a direct video link or the same local file on both sides.
        </p>
      </div>
    </main>
  )
}
