using System;
using System.IO;
using System.Text;
using System.Threading;
using System.Windows.Forms;

namespace Homelab.Mira.Computer
{
    internal static class Program
    {
        [STAThread]
        private static int Main(string[] args)
        {
            if (args.Length != 0 || !Console.IsInputRedirected || !Console.IsOutputRedirected) return 2;
            Console.SetOut(new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false), 1024) { AutoFlush = true });
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            try
            {
                using (var reader = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false, true), false, 1024))
                {
                    ConsentRequest request;
                    int initialized;
                    using (var deadline = new System.Threading.Timer(delegate { Environment.Exit(1); }, null, 5000, Timeout.Infinite))
                    {
                        var message = ConsentProtocol.Object(ConsentProtocol.ReadLine(reader));
                        ConsentProtocol.Keys(message, "id", "method", "params");
                        initialized = ConsentProtocol.Id(message, 0);
                        if (ConsentProtocol.Text(message, "method", 10) != "initialize")
                            throw new InvalidDataException("Initialize local consent first.");
                        request = ConsentRequest.Parse(ConsentProtocol.Parameters(message));
                    }
                    using (var form = new ConsentForm(request))
                    {
                        ConsentProtocol.Write(new { id = initialized, result = new { protocol = 1 } });
                        var input = new Thread(delegate()
                        {
                            try
                            {
                                int previous = initialized;
                                for (;;)
                                {
                                    string line = ConsentProtocol.ReadLine(reader);
                                    if (line == null) break;
                                    var message = ConsentProtocol.Object(line);
                                    ConsentProtocol.Keys(message, "id", "method", "params");
                                    int id = ConsentProtocol.Id(message, previous);
                                    previous = id;
                                    ConsentProtocol.Keys(ConsentProtocol.Parameters(message));
                                    string method = ConsentProtocol.Text(message, "method", 5);
                                    if (method == "stop") break;
                                    if (method != "check") break;
                                    form.CheckReady();
                                    ConsentProtocol.Write(new { id = id, result = new { ready = true } });
                                }
                            }
                            catch (Exception) { /* Malformed input, EOF and unavailable state all stop access. */ }
                            finally { form.Retire(); }
                        });
                        input.IsBackground = true;
                        input.Start();
                        Application.Run(form);
                    }
                }
                return 0;
            }
            catch (Exception)
            {
                Console.Error.WriteLine("Mira local computer consent is unavailable.");
                return 1;
            }
        }
    }
}

