using System;
using System.Collections.Generic;
using System.IO;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;

// One small, versioned UI protocol. No filesystem, launcher, credential or input proxy.
internal static class DesktopBridge
{
    internal const string Dashboard = "https://dashboard.home.rajohan.no";
    internal const string Auth = "https://auth.rajohan.no";
    internal static bool SameOrigin(string value, string origin)
    {
        Uri uri;
        return value != null && value.Length <= 8192 && Uri.TryCreate(value, UriKind.Absolute, out uri) &&
            uri.Scheme == "https" && uri.UserInfo == "" && uri.GetLeftPart(UriPartial.Authority) == origin;
    }
    internal static bool ApplicationUrl(string value) { return SameOrigin(value, Dashboard) || SameOrigin(value, Auth); }
    internal static bool ExternalUrl(string value)
    {
        Uri uri;
        return value != null && value.Length <= 8192 && Uri.TryCreate(value, UriKind.Absolute, out uri) &&
            uri.Scheme == "https" && uri.UserInfo == "" && !ApplicationUrl(value);
    }
    internal static Dictionary<string, object> Read(string source, string current, string json)
    {
        if (!SameOrigin(source, Dashboard) || !SameOrigin(current, Dashboard) || json == null || json.Length > 4096) throw new InvalidDataException();
        var serializer = new JavaScriptSerializer { MaxJsonLength = 4096, RecursionLimit = 4 };
        var value = serializer.Deserialize<Dictionary<string, object>>(json);
        if (value == null || value.Count < 4 || value.Count > 5 || !value.ContainsKey("type") || !value.ContainsKey("protocol") || !value.ContainsKey("id") || !value.ContainsKey("action") ||
            !Equals(value["type"], "mira-desktop") || !Equals(value["protocol"], 1) || !(value["id"] is string) ||
            !Regex.IsMatch((string)value["id"], @"\A[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\z")) throw new InvalidDataException();
        string action = value["action"] as string;
        if (action == "pair") {
            if (value.Count != 5 || !value.ContainsKey("ticket") || !(value["ticket"] is string) ||
                !Regex.IsMatch((string)value["ticket"], @"\Amira_pair_[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}\z")) throw new InvalidDataException();
        } else if (value.Count != 4 || (action != "state" && action != "connect" && action != "stop" && action != "forget" && action != "update")) throw new InvalidDataException();
        return value;
    }
    internal static string Reply(string id, DesktopConnection connection, string error = null)
    {
        return new JavaScriptSerializer().Serialize(new {
            type = "mira-desktop", protocol = 1, id = id, error = error,
            state = new {
                message = connection.Message, computerId = connection.ComputerId,
                busy = connection.Busy, canStart = connection.CanStart,
                canStop = connection.CanStop, canUpdate = connection.CanUpdate
            }
        });
    }
}
