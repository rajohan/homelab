using System;
using System.Drawing;
using System.Globalization;
using System.Windows.Forms;

namespace Homelab.Mira.Computer
{
    // Preserve local consent on PCs where the WebView2 runtime itself cannot start.
    internal sealed class ConsentRecoveryView : TableLayoutPanel
    {
        private readonly Label heading = new Label(), detail = new Label(), status = new Label();
        private readonly ComboBox windows = new ComboBox { DropDownStyle = ComboBoxStyle.DropDownList };
        private readonly CheckBox foreground = new CheckBox();
        private readonly Button allow = new DesktopButton { Primary = true }, stop = new DesktopButton();
        private readonly bool pickWindow;
        private readonly Func<int, bool> available;
        private bool active;
        internal ConsentRecoveryView(bool pick, string[] names, string permission, bool control, Func<int, bool> available, Action<string> decide)
        {
            this.available = available; pickWindow = pick;
            Dock = DockStyle.Fill; AutoScroll = true; Padding = new Padding(20); ColumnCount = 1;
            ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
            foreach (var text in new[] { heading, detail, status }) {
                text.AutoSize = true; text.Dock = DockStyle.Fill; text.UseMnemonic = false; text.Margin = new Padding(0, 4, 0, 8);
            }
            heading.Font = new Font(Font, FontStyle.Bold); detail.ForeColor = status.ForeColor = MiraWindow.Muted;
            Controls.Add(heading); Controls.Add(detail);
            windows.AccessibleName = "Window to share"; windows.Visible = pick; windows.Dock = DockStyle.Top;
            windows.Items.AddRange(names); windows.SelectedIndexChanged += delegate { UpdateAllow(); }; Controls.Add(windows);
            foreground.Text = permission; foreground.Visible = permission.Length > 0; foreground.AutoSize = true;
            foreground.CheckedChanged += delegate { UpdateAllow(); }; Controls.Add(foreground); Controls.Add(status);
            var buttons = new FlowLayoutPanel { AutoSize = true, Dock = DockStyle.Fill };
            stop.Text = "Decline"; allow.Text = control ? "Allow control" : "Allow viewing";
            stop.AutoSize = allow.AutoSize = true;
            stop.Click += delegate { decide("stop"); };
            allow.Click += delegate { if (allow.Enabled) decide("allow:" + (pickWindow ? windows.SelectedIndex.ToString(CultureInfo.InvariantCulture) : "screen") + (foreground.Checked ? ":yes" : ":no")); };
            buttons.Controls.Add(stop); buttons.Controls.Add(allow); Controls.Add(buttons);
        }
        internal void Present(bool sharing, string title, string message, string time)
        {
            active = sharing; heading.Text = title; detail.Text = message; status.Text = time;
            stop.Text = active ? "Stop access" : "Decline"; allow.Visible = !active;
            windows.Visible = !active && pickWindow; foreground.Visible = !active && foreground.Text.Length > 0;
            UpdateAllow();
        }
        private void UpdateAllow()
        {
            allow.Enabled = !active && (!pickWindow || available(windows.SelectedIndex)) && (foreground.Text.Length == 0 || foreground.Checked);
        }
        protected override void Dispose(bool disposing)
        {
            if (disposing) heading.Font.Dispose();
            base.Dispose(disposing);
        }
    }
}
