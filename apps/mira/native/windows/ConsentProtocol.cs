using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text;
using System.Web.Script.Serialization;

namespace Homelab.Mira.Computer
{
    internal sealed class ConsentRequest
    {
        internal string Id;
        internal string RunId;
        internal string Origin;
        internal string Mode;
        internal DateTime ConsentExpiresAt;
        internal DateTime ExpiresAt;

        internal static ConsentRequest Parse(string line)
        {
            return Parse(ConsentProtocol.Object(line));
        }
        internal static ConsentRequest Parse(Dictionary<string, object> value)
        {
            ConsentProtocol.Keys(value, "id", "runId", "origin", "mode", "consentExpiresAt", "expiresAt");
            string id = ConsentProtocol.Text(value, "id", 36);
            string run = ConsentProtocol.Text(value, "runId", 36);
            Guid parsed;
            if (!Guid.TryParseExact(id, "D", out parsed) || !Guid.TryParseExact(run, "D", out parsed))
                throw new InvalidDataException("Invalid consent identity.");
            string origin = ConsentProtocol.Text(value, "origin", 512);
            foreach (char character in origin)
                if (character > 126) throw new InvalidDataException("Use the canonical server origin.");
            Uri uri;
            if (!Uri.TryCreate(origin, UriKind.Absolute, out uri) || uri.Scheme != "https" ||
                uri.UserInfo.Length != 0 || uri.AbsolutePath != "/" || uri.Query.Length != 0 ||
                uri.Fragment.Length != 0 || origin != uri.GetLeftPart(UriPartial.Authority))
                throw new InvalidDataException("Invalid private server origin.");
            string mode = ConsentProtocol.Text(value, "mode", 7);
            if (mode != "view" && mode != "control") throw new InvalidDataException("Invalid consent scope.");
            DateTime consent = Timestamp(ConsentProtocol.Text(value, "consentExpiresAt", 40));
            DateTime expires = Timestamp(ConsentProtocol.Text(value, "expiresAt", 40));
            DateTime now = DateTime.UtcNow;
            if (consent <= now || consent > expires || consent > now.AddMinutes(1) || expires > now.AddMinutes(5))
                throw new InvalidDataException("Consent expired or exceeded its deadline.");
            return new ConsentRequest { Id = id, RunId = run, Origin = origin, Mode = mode, ConsentExpiresAt = consent, ExpiresAt = expires };
        }

        private static DateTime Timestamp(string value)
        {
            DateTime parsed;
            if (!DateTime.TryParseExact(value, "yyyy-MM-dd'T'HH:mm:ss.fff'Z'",
                CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal, out parsed))
                throw new InvalidDataException("Invalid consent deadline.");
            return parsed;
        }
    }

    // A private, bounded JSONL pipe. No sockets, remote URLs or executable arguments.
    internal static class ConsentProtocol
    {
        private static readonly object OutputLock = new object();
        private static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 8192, RecursionLimit = 6 };

        internal static Dictionary<string, object> Object(string line)
        {
            if (String.IsNullOrEmpty(line) || line.Length > 8192) throw new InvalidDataException("Invalid message.");
            Dictionary<string, object> value;
            lock (Json) { value = Json.DeserializeObject(line) as Dictionary<string, object>; }
            if (value == null) throw new InvalidDataException("Expected a message object.");
            return value;
        }

        internal static void Keys(Dictionary<string, object> value, params string[] names)
        {
            if (value.Count != names.Length) throw new InvalidDataException("Unexpected message fields.");
            foreach (string name in names)
                if (!value.ContainsKey(name)) throw new InvalidDataException("Missing message field.");
        }

        internal static string Text(Dictionary<string, object> value, string name, int limit)
        {
            object raw;
            string text = value.TryGetValue(name, out raw) ? raw as string : null;
            if (String.IsNullOrEmpty(text) || text.Length > limit) throw new InvalidDataException("Invalid message field.");
            foreach (char character in text)
                if (Char.IsControl(character)) throw new InvalidDataException("Invalid message character.");
            return text;
        }

        internal static int Id(Dictionary<string, object> value, int previous)
        {
            object raw;
            if (!value.TryGetValue("id", out raw) || !(raw is int) || (int)raw <= previous)
                throw new InvalidDataException("Invalid message sequence.");
            return (int)raw;
        }

        internal static Dictionary<string, object> Parameters(Dictionary<string, object> value)
        {
            object raw;
            var parameters = value.TryGetValue("params", out raw) ? raw as Dictionary<string, object> : null;
            if (parameters == null) throw new InvalidDataException("Expected message parameters.");
            return parameters;
        }

        internal static string ReadLine(TextReader reader)
        {
            var line = new StringBuilder();
            int consumed = 0;
            for (;;)
            {
                int next = reader.Read();
                if (next < 0) return null;
                if (++consumed > 8193) throw new InvalidDataException("Message too large.");
                if (next == '\n')
                {
                    if (line.Length > 0 && line[line.Length - 1] == '\r') line.Length--;
                    return line.ToString();
                }
                if (line.Length == 8192) throw new InvalidDataException("Message too large.");
                line.Append((char)next);
            }
        }

        internal static void Write(object value)
        {
            lock (OutputLock)
            {
                string line;
                lock (Json) { line = Json.Serialize(value); }
                Console.Out.WriteLine(line);
                Console.Out.Flush();
            }
        }
    }
}
