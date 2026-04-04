import { redirect } from "next/navigation";

export default function BrowserPage() {
  redirect("/work?launch=browser");
}
