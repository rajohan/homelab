# Rajohan brand assets

These SVGs come from the owner's supplied Rajohan logo collection.

- `rajohan.svg`: Favicon-01 adjusted horizontally so the visible artwork has the same 69.82-unit black margin on all four sides of its 608-unit canvas. Used by both HTML entry points and the home-screen manifest.
- `rajohan-mark.svg`: the same artwork without its background rectangle, used on dark application surfaces.

- `rajohan.ico`: Windows resource generated from the padded SVG, with 16, 20, 24, 32, 40, 48, 64, 128 and 256 pixel images. Shared by the companion, native consent window and worker executables.
- `rajohan-180.png`: the same square artwork at 180 pixels for iPhone/iPad home-screen installation. The operating system applies its own rounded corners.

Regenerate the ICO on Windows with the OS .NET Framework compiler, from the repository root:

```powershell
$csc = Join-Path $env:SystemRoot "Microsoft.NET/Framework64/v4.0.30319/csc.exe"
& $csc /nologo /target:exe /reference:System.Drawing.dll /reference:System.Xml.Linq.dll /out:BrandIcon.exe scripts\BrandIcon.cs
& .\BrandIcon.exe packages\ui\src\assets\rajohan.svg packages\ui\src\assets\rajohan.ico
```

`BrandIcon.exe` and the 256-pixel PNG preview are development outputs; commit the ICO and 180-pixel PNG. The generator reads the polygon coordinates and viewBox from the shared SVG. Requalify the generator if the artwork changes from monochrome polygons.

Do not duplicate the artwork in individual applications.
