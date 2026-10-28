using System;
using System.IO;
using System.Text;
using System.Threading;
using Homelab.Mira.Computer;

// Bounded anonymous-pipe lease for the packaged CLI, without credentials or command execution.
internal static class InstallationProtocol
{
    internal static int Run(string directory)
    {
        if (!Console.IsInputRedirected || !Console.IsOutputRedirected) return 1;
        try
        {
            using (var lease = InstallationLease.Open(directory, false))
            using (var reader = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false, true), false, 1024))
            {
                Console.SetOut(new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false), 1024) { AutoFlush = true });
                using (var deadline = new Timer(delegate { Environment.Exit(1); }, null, 5000, Timeout.Infinite))
                {
                    var message = ConsentProtocol.Object(ConsentProtocol.ReadLine(reader));
                    ConsentProtocol.Keys(message, "id", "method", "params");
                    int id = ConsentProtocol.Id(message, 0);
                    ConsentProtocol.Keys(ConsentProtocol.Parameters(message));
                    if (ConsentProtocol.Text(message, "method", 10) != "initialize") return 1;
                    ConsentProtocol.Write(new { id = id, result = new { protocol = 1 } });
                }
                // No further commands are accepted. EOF or any byte retires this lease.
                return reader.Read() < 0 ? 0 : 1;
            }
        }
        catch { return 1; }
    }
}
