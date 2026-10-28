using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Xml;
using System.Xml.Linq;

// Development-only rasterization of the shared monochrome polygon artwork.
// Compile with the OS .NET compiler; no image service or extra package is required.
internal static class BrandIcon
{
    private static float Number(string text) { return float.Parse(text, CultureInfo.InvariantCulture); }
    private static int Main(string[] args)
    {
        if (args.Length != 2) return 1;
        XDocument source;
        using (var reader = XmlReader.Create(args[0], new XmlReaderSettings { DtdProcessing = DtdProcessing.Prohibit, XmlResolver = null }))
            source = XDocument.Load(reader);
        var svg = source.Root;
        var ns = svg.Name.Namespace;
        float[] box = svg.Attribute("viewBox").Value.Split(' ').Select(Number).ToArray();
        if (box.Length != 4 || box[2] != box[3] || box[2] <= 0) throw new InvalidDataException("Square icon required.");
        var polygons = svg.Elements(ns + "polygon").Select(element =>
        {
            float[] coordinates = element.Attribute("points").Value.Split(new[] { ' ', ',', '\n', '\r', '\t' }, StringSplitOptions.RemoveEmptyEntries).Select(Number).ToArray();
            if (coordinates.Length % 2 != 0) throw new InvalidDataException("Invalid polygon.");
            return Enumerable.Range(0, coordinates.Length / 2).Select(index => new PointF(coordinates[index * 2], coordinates[index * 2 + 1])).ToArray();
        }).ToArray();
        if (polygons.Length != 3 || svg.Element(ns + "rect").Attribute("fill").Value != "#000")
            throw new InvalidDataException("Requalify changes to the shared icon artwork.");
        int[] sizes = { 16, 20, 24, 32, 40, 48, 64, 128, 256 };
        var images = new List<byte[]>();
        foreach (int size in sizes)
        {
            using (var large = new Bitmap(size * 4, size * 4, PixelFormat.Format32bppArgb))
            using (var graphics = Graphics.FromImage(large))
            using (var small = new Bitmap(size, size, PixelFormat.Format32bppArgb))
            using (var output = Graphics.FromImage(small))
            using (var stream = new MemoryStream())
            {
                graphics.Clear(Color.Black);
                graphics.SmoothingMode = SmoothingMode.AntiAlias;
                float scale = size * 4 / box[2];
                foreach (var polygon in polygons)
                    graphics.FillPolygon(Brushes.White, polygon.Select(point => new PointF((point.X - box[0]) * scale, (point.Y - box[1]) * scale)).ToArray());
                output.Clear(Color.Black);
                output.CompositingQuality = CompositingQuality.HighQuality;
                output.InterpolationMode = InterpolationMode.HighQualityBicubic;
                output.PixelOffsetMode = PixelOffsetMode.HighQuality;
                output.DrawImage(large, new Rectangle(0, 0, size, size));
                small.Save(stream, ImageFormat.Png);
                images.Add(stream.ToArray());
                if (size == 256) small.Save(Path.ChangeExtension(args[1], ".png"), ImageFormat.Png);
            }
        }
        using (var stream = new FileStream(args[1], FileMode.Create, FileAccess.Write, FileShare.None))
        using (var writer = new BinaryWriter(stream))
        {
            writer.Write((ushort)0); writer.Write((ushort)1); writer.Write((ushort)sizes.Length);
            int offset = 6 + 16 * sizes.Length;
            for (int i = 0; i < sizes.Length; i++)
            {
                writer.Write((byte)(sizes[i] == 256 ? 0 : sizes[i])); writer.Write((byte)(sizes[i] == 256 ? 0 : sizes[i]));
                writer.Write((byte)0); writer.Write((byte)0); writer.Write((ushort)1); writer.Write((ushort)32);
                writer.Write(images[i].Length); writer.Write(offset); offset += images[i].Length;
            }
            foreach (byte[] image in images) writer.Write(image);
        }
        return 0;
    }
}
