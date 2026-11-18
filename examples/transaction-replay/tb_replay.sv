// Tool-maintenance trace fixture. Drive with clk low, sample before the rising
// edge, observe after NBA/combinational settlement. No model-generated expected values.
module tb_replay;
logic clk=0, rst=1, s_axis_tvalid=0, m_axis_tready=0;
logic [7:0] s_axis_tdata=0;
wire [7:0] m_axis_tdata; wire m_axis_tvalid,s_axis_tready;
axis_pair dut(.*);
integer file_handle; string trace_file; integer next_data=16; bit accepted;
task sample_values;
 $fwrite(file_handle,"{\"rst\":\"%0d\",\"d0\":\"%0d\",\"v0\":\"%0d\",\"r0\":\"%0d\",\"d1\":\"%0d\",\"v1\":\"%0d\",\"r1\":\"%0d\",\"d2\":\"%0d\",\"v2\":\"%0d\",\"r2\":\"%0d\"}",rst,s_axis_tdata,s_axis_tvalid,s_axis_tready,dut.mid_data,dut.mid_valid,dut.mid_ready,m_axis_tdata,m_axis_tvalid,m_axis_tready);
endtask
initial begin
 if(!$value$plusargs("TRACE=%s",trace_file))$fatal(1,"trace path required");
 file_handle=$fopen(trace_file,"w");if(!file_handle)$fatal(1,"cannot open trace");
 $fwrite(file_handle,"{\"format\":\"rtlarch-rv-samples-v1\",\"clock\":{\"id\":\"clk\",\"edge\":\"rising\"},\"sampling\":\"pre_edge_handshake_post_edge_settled\",\"rows\":[");
 for(int cycle=0;cycle<56;cycle++)begin
  rst=(cycle==0 || cycle==28);s_axis_tvalid=cycle>0&&cycle<45;s_axis_tdata=8'(next_data);
  m_axis_tready=!(cycle>=10&&cycle<19);
  #4;
  if(cycle!=0)$fwrite(file_handle,",");$fwrite(file_handle,"{\"edge\":%0d,\"pre\":",cycle);sample_values();
  accepted=!rst&&s_axis_tvalid&&s_axis_tready;
  clk=1;#1;$fwrite(file_handle,",\"post\":");sample_values();$fwrite(file_handle,"}");
  #5;clk=0;if(accepted)next_data++;
 end
 $fwrite(file_handle,"]}");$fclose(file_handle);$display("REPLAY_CAPTURED");$finish;
end
endmodule
