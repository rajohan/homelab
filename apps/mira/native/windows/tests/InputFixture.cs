using System;
using System.Diagnostics;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using Homelab.Mira.Computer;

// Only the disposable hosted qualification runs this fixture. Its pipe can read
// state or close the form; all text/counter changes must come from native input.
internal sealed class InputFixture : Form
{
    private readonly TextBox entry = new TextBox();
    private readonly Button button = new Button();
    private readonly Label counter = new Label();
    private int count;

    private InputFixture()
    {
        Text = "Mira isolated Windows input fixture";
        FormBorderStyle = FormBorderStyle.None;
        StartPosition = FormStartPosition.Manual;
        Location = new Point(100, 100);
        ClientSize = new Size(480, 240);
        AutoScaleMode = AutoScaleMode.None;
        BackColor = Color.FromArgb(20, 35, 60);
        Controls.Add(new Label { Text = Text, ForeColor = Color.White, Location = new Point(24, 20), Size = new Size(430, 30) });
        entry.Location = new Point(24, 75);
        entry.Size = new Size(400, 28);
        entry.MaxLength = 100;
        button.Text = "Increment fixture";
        button.Location = new Point(24, 130);
        button.Size = new Size(200, 40);
        counter.Text = "Count: 0";
        counter.ForeColor = Color.White;
        counter.Location = new Point(250, 140);
        counter.Size = new Size(150, 25);
        button.Click += delegate { count++; counter.Text = "Count: " + count; };
        Controls.Add(entry);
        Controls.Add(button);
        Controls.Add(counter);
    }

    private object State()
    {
        return new
        {
            pid = Process.GetCurrentProcess().Id,
            session = Process.GetCurrentProcess().SessionId,
            interactive = Environment.UserInteractive,
            executable = Process.GetCurrentProcess().MainModule.FileName,
            windowId = Handle.ToInt64().ToString(CultureInfo.InvariantCulture),
            title = Text, text = entry.Text, count = count,
            width = Width, height = Height,
            entry = new { x = entry.Left + entry.Width / 2, y = entry.Top + entry.Height / 2 },
            button = new { x = button.Left + button.Width / 2, y = button.Top + button.Height / 2 }
        };
    }

    private void ReadRequests()
    {
        try
        {
            using (var input = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false, true), false, 1024))
            {
                int previous = 0;
                for (;;)
                {
                    string line = ConsentProtocol.ReadLine(input);
                    if (line == null) break;
                    var message = ConsentProtocol.Object(line);
                    ConsentProtocol.Keys(message, "id", "method", "params");
                    int id = ConsentProtocol.Id(message, previous);
                    previous = id;
                    ConsentProtocol.Keys(ConsentProtocol.Parameters(message));
                    string method = ConsentProtocol.Text(message, "method", 5);
                    if (method != "state") break;
                    object state = Invoke(new Func<object>(State));
                    ConsentProtocol.Write(new { id = id, result = state });
                }
            }
        }
        catch (Exception) { /* Invalid input and parent loss close this fixture. */ }
        finally
        {
            try { BeginInvoke(new Action(Close)); }
            catch (InvalidOperationException) { }
        }
    }

    [STAThread]
    private static int Main(string[] args)
    {
        if (args.Length != 0 || !Console.IsInputRedirected || !Console.IsOutputRedirected ||
            Environment.GetEnvironmentVariable("GITHUB_ACTIONS") != "true" ||
            Environment.GetEnvironmentVariable("RUNNER_ENVIRONMENT") != "github-hosted") return 2;
        Console.SetOut(new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false), 1024) { AutoFlush = true });
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        using (var deadline = new System.Threading.Timer(delegate { Environment.Exit(1); }, null, 60000, Timeout.Infinite))
        using (var form = new InputFixture())
        {
            form.Shown += delegate
            {
                var input = new Thread(form.ReadRequests) { IsBackground = true };
                input.Start();
            };
            Application.Run(form);
        }
        return 0;
    }
}
