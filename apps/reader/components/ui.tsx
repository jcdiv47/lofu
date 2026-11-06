import { Image, signal, Text, View } from "nsh";
import alertIcon from "../assets/icons/alert.svg";
import allIcon from "../assets/icons/all.svg";
import archiveIcon from "../assets/icons/archive.svg";
import backIcon from "../assets/icons/back.svg";
import chevronIcon from "../assets/icons/chevron.svg";
import clockIcon from "../assets/icons/clock.svg";
import closeIcon from "../assets/icons/close.svg";
import externalIcon from "../assets/icons/external.svg";
import folderIcon from "../assets/icons/folder.svg";
import gridIcon from "../assets/icons/grid.svg";
import hashIcon from "../assets/icons/hash.svg";
import highlighterIcon from "../assets/icons/highlighter.svg";
import inboxIcon from "../assets/icons/inbox.svg";
import linkIcon from "../assets/icons/link.svg";
import listIcon from "../assets/icons/list.svg";
import moreIcon from "../assets/icons/more.svg";
import refreshIcon from "../assets/icons/refresh.svg";
import searchIcon from "../assets/icons/search.svg";
import settingsIcon from "../assets/icons/settings.svg";
import starIcon from "../assets/icons/star.svg";
import starFillIcon from "../assets/icons/star-fill.svg";
import { look } from "../lib/look";

export const icons = {
  alert: alertIcon,
  all: allIcon,
  archive: archiveIcon,
  back: backIcon,
  chevron: chevronIcon,
  clock: clockIcon,
  close: closeIcon,
  external: externalIcon,
  folder: folderIcon,
  grid: gridIcon,
  hash: hashIcon,
  highlighter: highlighterIcon,
  inbox: inboxIcon,
  link: linkIcon,
  list: listIcon,
  more: moreIcon,
  refresh: refreshIcon,
  search: searchIcon,
  settings: settingsIcon,
  star: starIcon,
  starFill: starFillIcon,
};
export type IconName = keyof typeof icons;

/** A one-color icon, tinted to follow the theme. */
export function Icon(props: { name: IconName; size?: number; color?: string }) {
  const size = props.size ?? 16;
  return (
    <Image
      src={icons[props.name]}
      style={{ width: size, height: size, tintColor: props.color ?? look().inkSoft }}
    />
  );
}

/** A square icon button for toolbars; `label` is what screen readers say. */
export function IconButton(props: {
  name: IconName;
  label: string;
  onPress: () => void;
  color?: string;
  size?: number;
  testID?: string;
  active?: boolean;
}) {
  return (
    <View
      role="button"
      accessibilityLabel={props.label}
      testID={props.testID}
      onPress={props.onPress}
      class="h-8 w-8 items-center justify-center rounded-md active:opacity-60"
      style={{ backgroundColor: props.active ? look().selected : undefined }}
      hoverStyle={{ backgroundColor: look().selected }}
    >
      <Icon name={props.name} size={props.size ?? 17} color={props.color} />
    </View>
  );
}

const monogramColors = ["#b4654a", "#5f7f6a", "#5b6f93", "#8a6a9a", "#a5803f", "#6b7d7d"];
const hash = (s: string) => {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
};

/** The site's icon, or its initial on a color picked from the domain. */
export function Favicon(props: { url: string | null; domain: string; size?: number }) {
  const size = props.size ?? 14;
  // Rows are recycled: remember which URL failed, not just that one did.
  const failedUrl = signal<string | null>(null);
  const color = () => monogramColors[hash(props.domain) % monogramColors.length];
  return (
    <If
      when={props.url && failedUrl() !== props.url}
      else={
        <View
          class="items-center justify-center"
          style={{ width: size, height: size, borderRadius: size / 4, backgroundColor: color() }}
        >
          <Text
            style={{ color: "#fff", fontSize: size * 0.62, fontWeight: "700", lineHeight: size }}
          >
            {(props.domain.replace(/^www\./, "")[0] ?? "?").toUpperCase()}
          </Text>
        </View>
      }
    >
      <Image
        src={props.url ?? ""}
        onError={() => failedUrl.set(props.url)}
        style={{ width: size, height: size, borderRadius: size / 4 }}
      />
    </If>
  );
}
