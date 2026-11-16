const controls =
  'a,button,input,textarea,select,option,label,summary,[contenteditable]:not([contenteditable="false"]),[role="button"],[role="link"],[role="checkbox"],[role="radio"],[role="combobox"],[tabindex]';
export function permitsTaskNavigation(
  event: {
    target: { closest?: (selector: string) => unknown } | null;
    button?: number;
    defaultPrevented?: boolean;
    ctrlKey?: boolean;
    metaKey?: boolean;
    shiftKey?: boolean;
    altKey?: boolean;
  },
  selected: boolean,
) {
  return !(
    selected ||
    event.defaultPrevented ||
    (event.button ?? 0) !== 0 ||
    event.ctrlKey ||
    event.metaKey ||
    event.shiftKey ||
    event.altKey ||
    event.target?.closest?.(controls)
  );
}
