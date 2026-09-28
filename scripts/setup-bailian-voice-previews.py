"""Install official voice samples referenced by the checked-in catalogue."""
import json,pathlib,urllib.request,zipfile,sys
root=pathlib.Path(__file__).resolve().parents[1]
catalog=json.loads((root/'src/bailian-voice-catalog.json').read_text())
archive=root/'.runtime/tts-catalog-20260912/previews.zip'
archive.parent.mkdir(parents=True,exist_ok=True)
if not archive.exists():
    urllib.request.urlretrieve('https://help-static-aliyun-doc.aliyuncs.com/file-manage-files/zh-CN/20260720/tuuuqo/%E5%9F%BA%E7%A1%80%E9%9F%B3%E8%89%B2%E8%AF%95%E5%90%AC%E9%9F%B3%E9%A2%91%E5%8C%85.zip',archive)
output=root/'public/tts-previews';output.mkdir(parents=True,exist_ok=True)
wanted={pathlib.PurePosixPath(v['previewUrl']).name for v in catalog['voices'] if v['previewUrl'].startswith('/tts-previews/')}
with zipfile.ZipFile(archive) as z:
    entries={pathlib.PurePosixPath(i.filename).name:i for i in z.infolist() if not i.is_dir() and '__MACOSX' not in i.filename and not pathlib.PurePosixPath(i.filename).name.startswith('._')}
    missing=wanted-entries.keys()
    if missing:raise RuntimeError(f'Missing official samples: {sorted(missing)}')
    for name in wanted:
        if not name.endswith('.wav') or '/' in name:raise ValueError(name)
        (output/name).write_bytes(z.read(entries[name]))
print(f'Installed {len(wanted)} official WAV samples')
