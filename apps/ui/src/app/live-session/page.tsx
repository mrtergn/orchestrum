import Image from "next/image";
import Timeline from "./Timeline";

export const dynamic = "force-dynamic";

export default function LiveSessionPage() {
  return (
    <main className="max-w-6xl mx-auto px-6 py-10 space-y-6">
      <header className="flex items-center gap-3">
        <Image src="/favicon.svg" width={28} height={28} alt="Orchestrum" />
        <h1 className="text-2xl font-semibold">Live Session</h1>
      </header>

      <p className="text-sm text-zinc-400">
        One operational stage: baton owner, current truth, parallel lanes, and operator action on a single screen.
      </p>

      <Timeline />
    </main>
  );
}
