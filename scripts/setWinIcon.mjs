import fs from 'fs';
import * as ResEdit from 'resedit';

/**
 * Replace the Windows PE icon group in an .exe with a multi-size .ico.
 * Extra data after the PE (NSIS/caxa overlay) is preserved so packed
 * executables keep their payload.
 */
export function setWinIcon(exePath, icoPath) {
  const exe = ResEdit.NtExecutable.from(fs.readFileSync(exePath), { ignoreCert: true });
  const extra = exe.getExtraData();
  const extraCopy = extra ? Buffer.from(new Uint8Array(extra)) : null;

  const res = ResEdit.NtExecutableResource.from(exe);
  const iconFile = ResEdit.Data.IconFile.from(fs.readFileSync(icoPath));
  const groups = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries);
  const groupId = groups[0]?.id ?? 1;
  const lang = groups[0]?.lang ?? 1033;

  ResEdit.Resource.IconGroupEntry.replaceIconsForResource(
    res.entries,
    groupId,
    lang,
    iconFile.icons.map((item) => item.data)
  );

  res.outputResource(exe);
  if (extraCopy) {
    exe.setExtraData(extraCopy);
  }
  fs.writeFileSync(exePath, Buffer.from(exe.generate()));
}
